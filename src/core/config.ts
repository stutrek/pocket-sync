import type { Paths } from "./paths.ts";

export interface Config {
  /** Fixed port for the browser-facing web UI (the desktop window uses its own). */
  webPort: number;
  /** Bind address for the fixed-port server. 127.0.0.1 = this machine only. */
  webHost: string;
  /** Empty = auto-detect from the usual install locations for this OS. */
  calibrePath: string;
  ebookMetaPath: string;
  /** Empty = use the interpreter bundled with the app. */
  pythonPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  /** Launch the app when the user logs in (managed by src/desktop/autostart.ts). */
  startAtLogin: boolean;
  /** Master switch for auto-sync-on-connect (the tray Pause/Resume toggle). */
  autoSyncEnabled: boolean;
  discovery: {
    enabled: boolean;
    /** Seconds between discovery sweeps. */
    intervalSec: number;
    /** Seconds to listen for replies per sweep. */
    timeoutSec: number;
    /** First-class manual host list — UDP broadcast is often blocked (§16). */
    manualHosts: string[];
    /** Also probe the device's own hotspot address. */
    hotspotFallback: boolean;
    /** Ignore repeat announcements within this many seconds. */
    debounceSec: number;
  };
  upload: {
    /** Target directory on the device. */
    path: string;
    /** Firmware cap is 2048 bytes per frame. */
    chunkSize: number;
    retries: number;
    retryDelaySec: number;
    bookCooldownSec: number;
    socketTimeoutSec: number;
    /** Fall back to the firmware's WebDAV PUT when WebSocket retries run out. */
    webdavFallback: boolean;
  };
}

/** Empty Calibre paths mean "auto-detect" — see `calibreCandidates()`. */
export const DEFAULT_CONFIG: Config = {
  webPort: 8787,
  webHost: "127.0.0.1",
  calibrePath: "",
  ebookMetaPath: "",
  pythonPath: "",
  logLevel: "info",
  startAtLogin: false,
  autoSyncEnabled: true,
  discovery: {
    enabled: true,
    intervalSec: 30,
    timeoutSec: 2,
    manualHosts: [],
    hotspotFallback: false,
    debounceSec: 8,
  },
  upload: {
    path: "/",
    chunkSize: 2048,
    retries: 3,
    retryDelaySec: 2,
    bookCooldownSec: 1,
    socketTimeoutSec: 30,
    webdavFallback: true,
  },
};

function merge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    out[k] = cur && typeof cur === "object" && !Array.isArray(cur) ? merge(cur, v) : v;
  }
  return out as T;
}

export class ConfigStore {
  #config: Config;

  private constructor(readonly paths: Paths, config: Config) {
    this.#config = config;
  }

  static load(paths: Paths): ConfigStore {
    let cfg = DEFAULT_CONFIG;
    try {
      cfg = merge(DEFAULT_CONFIG, JSON.parse(Deno.readTextFileSync(paths.configFile)));
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        console.error(`config.json unreadable, using defaults: ${err}`);
      }
    }
    const store = new ConfigStore(paths, cfg);
    store.save();
    return store;
  }

  get current(): Config {
    return this.#config;
  }

  update(patch: unknown): Config {
    this.#config = merge(this.#config, patch);
    this.save();
    return this.#config;
  }

  save() {
    Deno.writeTextFileSync(this.paths.configFile, JSON.stringify(this.#config, null, 2) + "\n");
  }
}
