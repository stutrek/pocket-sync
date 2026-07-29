import type { Config, ConfigStore } from "../core/config.ts";
import type { Db } from "../core/db.ts";
import { shortHash } from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import type { Sidecar } from "../engine/sidecar.ts";
import { DeviceClient, type DeviceStatus } from "./client.ts";

export interface DeviceRow {
  id: string;
  kind: string;
  model: string | null;
  name: string | null;
  last_ip: string | null;
  last_port: number;
  first_seen: string;
  last_seen: string;
  id_strategy: string;
  status_json: string;
  notes: string | null;
}

export interface DeviceState {
  online: boolean;
  host: string;
  port: number;
  lastSeen: string;
  lastSyncAt?: string;
  lastSyncResult?: string;
  syncing: boolean;
}

/** Fields we'll accept from /api/status as a stable hardware identity. */
const ID_FIELDS = [
  "uuid",
  "serial",
  "serialNumber",
  "sn",
  "chipId",
  "chip_id",
  "mac",
  "macAddress",
  "deviceId",
  "device_id",
  "id",
];

export function stableIdentity(
  status: DeviceStatus,
): { id: string; strategy: string } | null {
  for (const field of ID_FIELDS) {
    const v = status?.[field];
    if (typeof v === "string" && v.trim().length >= 4 && !/^0+$/.test(v.trim())) {
      return { id: `cp-${shortHash(`${field}:${v.trim()}`)}`, strategy: field };
    }
    if (typeof v === "number" && v !== 0) {
      return { id: `cp-${shortHash(`${field}:${v}`)}`, strategy: field };
    }
  }
  return null;
}

export class DeviceManager {
  #state = new Map<string, DeviceState>();
  #lastAnnounce = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #sweeping = false;
  #lastSweepAt: string | null = null;
  #sweeps = 0;
  /** Last time any address answered at all, this process. */
  #lastContactAt: string | null = null;

  /** Called (debounced) when a device transitions offline -> online. */
  onConnect: ((deviceId: string) => void) | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly sidecar: Sidecar,
    private readonly log: Logger,
  ) {}

  get cfg(): Config {
    return this.config.current;
  }

  start() {
    if (this.#timer !== null) return;
    const tick = () => {
      this.sweep().catch((err) => this.log.error("discovery.failed", `Discovery sweep: ${err}`));
    };
    tick();
    this.#timer = setInterval(tick, Math.max(5, this.cfg.discovery.intervalSec) * 1000);
  }

  stop() {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Re-arm the timer after a settings change. `start()` fixes the interval when
   * it is called, so without this an edited `intervalSec` is reported by
   * `discoveryStatus()` but never actually used — the UI would claim a cadence
   * the app is not keeping.
   */
  restart() {
    this.stop();
    this.start();
  }

  /**
   * Whether discovery is actually looking, and how recently it looked.
   *
   * Scanning is continuous, but with `enabled: false` the only addresses checked
   * are the manual hosts — so the app can be sweeping every few seconds and
   * still be structurally unable to find a reader. The UI needs to be able to
   * say which of those it is instead of showing a bare "no devices yet".
   */
  discoveryStatus() {
    const d = this.cfg.discovery;
    return {
      running: this.#timer !== null,
      broadcast: d.enabled,
      manualHosts: d.manualHosts.filter((h) => h.trim()).length,
      hotspotFallback: d.hotspotFallback,
      intervalSec: Math.max(5, d.intervalSec),
      sweeping: this.#sweeping,
      lastSweepAt: this.#lastSweepAt,
      /** True when nothing at all would be probed. */
      blind: !d.enabled && !d.hotspotFallback &&
        d.manualHosts.filter((h) => h.trim()).length === 0,
      /**
       * Probing, but nothing on the network has ever replied — not a broadcast,
       * not a manual host. An empty network looks like this, and so does a
       * platform silently dropping our LAN traffic (macOS denies local network
       * access to an app it never prompted for), which is otherwise invisible.
       */
      silent: this.#sweeps >= 2 && this.#lastContactAt === null,
      platform: Deno.build.os,
    };
  }

  rows(): DeviceRow[] {
    return this.db.all<DeviceRow>("SELECT * FROM device ORDER BY name, id");
  }

  row(id: string): DeviceRow | undefined {
    return this.db.get<DeviceRow>("SELECT * FROM device WHERE id = ?", id);
  }

  state(id: string): DeviceState | undefined {
    return this.#state.get(id);
  }

  /** Row + live state, for the devices view. */
  view() {
    return this.rows().map((row) => ({
      ...row,
      status: JSON.parse(row.status_json || "{}"),
      state: this.#state.get(row.id) ?? {
        online: false,
        host: row.last_ip ?? "",
        port: row.last_port,
        lastSeen: row.last_seen,
        syncing: false,
      },
    }));
  }

  clientFor(id: string): DeviceClient | null {
    const st = this.#state.get(id);
    const row = this.row(id);
    const host = st?.host ?? row?.last_ip;
    if (!host) return null;
    return new DeviceClient(host, st?.port ?? row?.last_port ?? 81);
  }

  markSyncing(id: string, syncing: boolean, result?: string) {
    const st = this.#state.get(id);
    if (!st) return;
    st.syncing = syncing;
    if (!syncing && result) {
      st.lastSyncAt = new Date().toISOString();
      st.lastSyncResult = result;
    }
  }

  /** One discovery pass: UDP broadcast (via the vendored client) + direct probes. */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      const d = this.cfg.discovery;
      const candidates = new Map<string, number>(); // host -> ws port

      if (d.enabled) {
        try {
          const res = await this.sidecar.call<{ host: string | null; port: number | null }>(
            "discover",
            { timeout: d.timeoutSec, extraHosts: d.manualHosts, debug: false },
          );
          if (res.host) candidates.set(res.host, res.port ?? 81);
        } catch (err) {
          this.log.debug("discovery.udp.failed", `UDP discovery failed: ${err}`);
        }
      }
      // Manual hosts are first-class: LAN broadcast is frequently blocked (§16).
      for (const host of d.manualHosts) {
        if (host.trim()) candidates.set(host.trim(), 81);
      }
      if (d.hotspotFallback) candidates.set("192.168.4.1", 81);

      const seen = new Set<string>();
      for (const [host, port] of candidates) {
        const id = await this.#probe(host, port);
        if (id) seen.add(id);
      }
      if (seen.size) this.#lastContactAt = new Date().toISOString();

      // Anything previously online but missing this sweep is gone — unless we
      // are mid-sync with it, which is better proof of a connection than a
      // probe: a reader streaming an upload routinely misses the 4s
      // /api/status timeout, and calling that "lost" greys the dot and logs a
      // disconnect for a device we are actively talking to.
      for (const [id, st] of this.#state) {
        if (st.online && !seen.has(id) && !st.syncing) {
          st.online = false;
          this.log.info("device.lost", `Device ${this.label(id)} went offline`, { deviceId: id });
        }
      }
    } finally {
      this.#lastSweepAt = new Date().toISOString();
      this.#sweeps++;
      this.#sweeping = false;
    }
  }

  /** Probe one address; registers/updates the device and returns its id. */
  async #probe(host: string, port: number): Promise<string | null> {
    const client = new DeviceClient(host, port);
    let status: DeviceStatus;
    try {
      status = await client.status();
    } catch {
      return null;
    }

    const model = typeof status.device === "string" ? status.device : null;
    // Firmware may advertise a non-default upload port; discovery reports one too.
    const advertised = status.wsPort ?? status.websocketPort;
    if (typeof advertised === "number" && advertised > 0) port = advertised;
    const identity = stableIdentity(status);
    const id = identity?.id ?? this.#fallbackId(host, model);
    const strategy = identity?.strategy ?? "ip";
    const now = new Date().toISOString();

    const existing = this.row(id);
    if (existing) {
      this.db.run(
        `UPDATE device SET model = COALESCE(?, model), last_ip = ?, last_port = ?,
                           last_seen = ?, id_strategy = ?, status_json = ?
         WHERE id = ?`,
        model,
        host,
        port,
        now,
        strategy,
        JSON.stringify(status),
        id,
      );
    } else {
      this.db.run(
        `INSERT INTO device (id, kind, model, name, last_ip, last_port, first_seen, last_seen,
                             id_strategy, status_json)
         VALUES (?, 'crosspoint', ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        model,
        `Xteink ${model ?? "reader"}`,
        host,
        port,
        now,
        now,
        strategy,
        JSON.stringify(status),
      );
      this.db.run("INSERT INTO device_settings (device_id) VALUES (?) ON CONFLICT DO NOTHING", id);
      this.log.info(
        "device.new",
        `New device ${model ?? "?"} at ${host} (identity: ${strategy})` +
          (strategy === "ip"
            ? " — /api/status exposes no stable id, so this device is bound by address; rename it in the UI"
            : ""),
        { deviceId: id, detail: { status } },
      );
    }

    const prev = this.#state.get(id);
    const st: DeviceState = {
      ...(prev ?? { syncing: false }),
      online: true,
      host,
      port,
      lastSeen: now,
    } as DeviceState;
    this.#state.set(id, st);

    if (!prev?.online) {
      const last = this.#lastAnnounce.get(id) ?? 0;
      const debounceMs = Math.max(0, this.cfg.discovery.debounceSec) * 1000;
      if (Date.now() - last >= debounceMs) {
        this.#lastAnnounce.set(id, Date.now());
        this.log.info(
          "device.connected",
          `Device ${this.label(id)} connected at ${host} (upload port ${port})`,
          { deviceId: id, detail: { model, strategy } },
        );
        this.onConnect?.(id);
      }
    }
    return id;
  }

  /**
   * No stable field in /api/status: reuse the single known device of the same
   * model (DHCP moved it) rather than creating a duplicate row.
   */
  #fallbackId(host: string, model: string | null): string {
    const sameModel = this.db.all<DeviceRow>(
      "SELECT * FROM device WHERE id_strategy = 'ip' AND (model IS ? OR model = ?)",
      model,
      model,
    );
    if (sameModel.length === 1) return sameModel[0].id;
    const byIp = sameModel.find((r) => r.last_ip === host);
    if (byIp) return byIp.id;
    return `cp-${(model ?? "dev").toLowerCase()}-${shortHash(host)}`;
  }

  label(id: string): string {
    const row = this.row(id);
    return row?.name || row?.model || id;
  }

  rename(id: string, name: string) {
    this.db.run("UPDATE device SET name = ? WHERE id = ?", name.trim(), id);
  }

  remove(id: string) {
    this.db.run("DELETE FROM device WHERE id = ?", id);
    this.#state.delete(id);
  }
}
