import { createHash } from "node:crypto";
import type { Db } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import { lanAddress } from "../core/net.ts";
import type { DeviceKosyncSettings } from "../device/client.ts";
import type { DeviceManager } from "../device/manager.ts";
import type { ConfigStore, SyncServerConfig, UserConfig } from "../core/config.ts";
import { LOCAL_SYNC_SERVER_ID } from "../core/config.ts";
import { type ProgressPayload, type Reading, storedReport } from "./reading.ts";

/**
 * A sync server as the rest of the app sees it: the stored record for someone
 * else's, or the live-resolved one for ours.
 *
 * `available` is false when we cannot produce usable settings right now — ours
 * with the listener turned off, or with no LAN address to advertise. It is kept
 * in the list rather than filtered out so the UI can say *why* a reader is not
 * reporting instead of silently showing one fewer row.
 */
export interface SyncServer {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  /** Ours. Cannot be edited or removed — its URL and credentials are derived. */
  builtin: boolean;
  adopted: boolean;
  available: boolean;
  /** Why it is unavailable, in words the UI can print. */
  reason?: string;
}

/** Two URLs are the same server if they differ only in trailing slash or case. */
function sameUrl(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b) && norm(a) !== "";
}

/**
 * Someone else's server. Always available: we have no way to check it is up,
 * and refusing to configure a reader because we could not reach a third-party
 * host would be worse than letting the reader find out.
 */
function resolveStored(s: SyncServerConfig): SyncServer {
  return { ...s, builtin: false, adopted: !!s.adopted, available: true };
}

/**
 * A KOReader-compatible sync server, which CrossPoint firmware speaks natively
 * (Settings → System → KOReader Sync).
 *
 * We implement the compatible subset against our own database rather than
 * running the reference server, because the value here is mapping the reported
 * document hash back to *our* book — the same book optimized for an X3 and an
 * X4 is two files with two hashes, and only we know they are one book
 * (docs/DESIGN.md).
 *
 * This listener binds separately from the library UI: the reader has to reach
 * it over the LAN, but that must not put the library on the LAN too.
 */
export class KosyncServer {
  #server: Deno.HttpServer | null = null;
  /** Where the listener is actually bound, so `applyConfig()` can tell a no-op
   * change from one that has to rebind. */
  #at: { port: number; host: string } | null = null;

  constructor(
    private readonly db: Db,
    private readonly reading: Reading,
    private readonly devices: DeviceManager,
    private readonly config: ConfigStore,
    private readonly log: Logger,
  ) {}

  get users(): UserConfig[] {
    return this.config.current.users ?? [];
  }

  /**
   * Credentials are **per user**, generated on demand.
   *
   * This is how a report is attributed. Matching on the device name the firmware
   * happens to send is guesswork, and guessing wrong is not harmless: two people
   * with a copy of the same book have identical delivered bytes, so the same
   * document hash, and a misattributed report overwrites the other person's
   * position. The credentials the reader authenticated with are unambiguous.
   */
  credentials(userId: string): { username: string; password: string } {
    const existing = this.db.get<{ username: string }>(
      "SELECT username FROM kosync_user WHERE user_id = ?",
      userId,
    );
    if (existing) {
      return {
        username: existing.username,
        password: this.#password(existing.username) ?? "",
      };
    }

    const username = this.#allocateUsername(userId);
    const password = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    this.db.run(
      "INSERT INTO kosync_user (username, key_md5, user_id, created_at) VALUES (?, ?, ?, ?)",
      username,
      md5Hex(password),
      userId,
      new Date().toISOString(),
    );
    this.db.run(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      `kosync.password.${username}`,
      password,
    );
    this.log.info("kosync.user", `Created sync credentials for user ${userId}`);
    return { username, password };
  }

  /** Where a reader should report progress, or null if we can't work it out. */
  url(): string | null {
    const host = lanAddress();
    return host ? `http://${host}:${this.config.current.kosync.port}` : null;
  }

  // --- the list of servers a person can report to ---

  /**
   * Every server this person could use, ours first.
   *
   * Ours is rebuilt on every call rather than stored, so a DHCP move, a changed
   * port or a rename fixes itself everywhere at once — a frozen copy in
   * `config.json` would go stale silently and readers would report into the
   * void. Everything after it is a server the user added or we adopted off a
   * reader.
   */
  servers(userId: string): SyncServer[] {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return [];
    return [this.#localServer(userId), ...(user.syncServers ?? []).map(resolveStored)];
  }

  /** One server by id, ours included. */
  server(userId: string, serverId: string | null | undefined): SyncServer | undefined {
    if (!serverId) return undefined;
    return this.servers(userId).find((s) => s.id === serverId);
  }

  /**
   * The server at this address, if this person already has it.
   *
   * This is what stops adoption repeating: a reader pointed at an address
   * already on the holder's list has been surfaced to them once and been given
   * a place in the UI, so the next attempt pushes what they chose instead of
   * adopting the same server again and re-pinning the reader to it.
   */
  serverByUrl(userId: string, url: string): SyncServer | undefined {
    return this.servers(userId).find((s) => sameUrl(s.url, url));
  }

  /**
   * Where this person's readers report unless one overrides it.
   *
   * A default pointing at a server that has since been removed falls back to
   * ours rather than returning nothing — the list always has ours in it, so
   * "no server at all" is not a state a user can get into by deleting one.
   */
  defaultServer(userId: string): SyncServer | undefined {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return undefined;
    return this.server(userId, user.defaultSyncServerId) ?? this.#localServer(userId);
  }

  /**
   * Record a server for this person, or return the one already matching.
   *
   * Matched on URL alone, not URL + username: the same box with a different
   * account is a re-registration, not a second server, and duplicating it would
   * put two identical-looking rows in the picker.
   */
  addServer(
    userId: string,
    input: { name?: string; url: string; username: string; password: string; adopted?: boolean },
  ): SyncServer | { error: string } {
    const url = input.url.trim().replace(/\/+$/, "");
    if (!url) return { error: "a server URL is required" };
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return { error: `“${input.url}” is not a URL` };
    }
    if (this.#localServer(userId).url && sameUrl(url, this.#localServer(userId).url)) {
      return { error: "that is this computer's own sync server, which is already in the list" };
    }

    const user = this.users.find((u) => u.id === userId);
    if (!user) return { error: "no such person" };

    const existing = (user.syncServers ?? []).find((s) => sameUrl(s.url, url));
    if (existing) {
      // Credentials can legitimately change under a URL we already know, so
      // take the new ones rather than handing back a stale login.
      const updated: SyncServerConfig = {
        ...existing,
        name: input.name?.trim() || existing.name,
        username: input.username,
        password: input.password,
      };
      this.#writeServers(userId, (list) => list.map((s) => s.id === existing.id ? updated : s));
      return resolveStored(updated);
    }

    const server: SyncServerConfig = {
      id: newId(),
      name: input.name?.trim() || host,
      url,
      username: input.username,
      password: input.password,
      adopted: input.adopted ?? false,
    };
    this.#writeServers(userId, (list) => [...list, server]);
    this.log.info(
      "kosync.server.added",
      `${input.adopted ? "Adopted" : "Added"} sync server ${server.name} (${url}) for ` +
        `${user.name}`,
    );
    return resolveStored(server);
  }

  updateServer(
    userId: string,
    serverId: string,
    patch: Partial<Pick<SyncServerConfig, "name" | "url" | "username" | "password">>,
  ): SyncServer | { error: string } {
    if (serverId === LOCAL_SYNC_SERVER_ID) {
      return { error: "this computer's own sync server is not editable" };
    }
    const user = this.users.find((u) => u.id === userId);
    const existing = (user?.syncServers ?? []).find((s) => s.id === serverId);
    if (!existing) return { error: "no such sync server" };
    const url = patch.url !== undefined ? patch.url.trim().replace(/\/+$/, "") : existing.url;
    try {
      new URL(url);
    } catch {
      return { error: `“${patch.url}” is not a URL` };
    }
    // An edited server is no longer just what the reader happened to hold.
    const next: SyncServerConfig = { ...existing, ...patch, url, adopted: false };
    this.#writeServers(userId, (list) => list.map((s) => s.id === serverId ? next : s));
    return resolveStored(next);
  }

  /**
   * Forget one. Ours cannot be removed — turning it off is a Settings switch,
   * because it is one server shared by everybody, not this person's to delete.
   */
  removeServer(userId: string, serverId: string): { ok: true } | { error: string } {
    if (serverId === LOCAL_SYNC_SERVER_ID) {
      return { error: "this computer's own sync server cannot be removed" };
    }
    this.#writeServers(userId, (list) => list.filter((s) => s.id !== serverId));
    const user = this.users.find((u) => u.id === userId);
    if (user?.defaultSyncServerId === serverId) this.setDefaultServer(userId, null);
    // Readers overriding to it fall back to the holder's default rather than being
    // left pointing at a server nothing in the app can describe any more.
    this.db.run(
      "UPDATE device_settings SET sync_server_id = NULL WHERE sync_server_id = ?",
      serverId,
    );
    return { ok: true };
  }

  /** `null` means ours. */
  setDefaultServer(userId: string, serverId: string | null): { ok: true } | { error: string } {
    if (serverId && serverId !== LOCAL_SYNC_SERVER_ID && !this.server(userId, serverId)) {
      return { error: "no such sync server" };
    }
    this.config.update({
      users: this.users.map((u) =>
        u.id === userId
          ? {
            ...u,
            defaultSyncServerId: !serverId || serverId === LOCAL_SYNC_SERVER_ID
              ? undefined
              : serverId,
          }
          : u
      ),
    });
    return { ok: true };
  }

  /**
   * Everything a reader needs typed into **Settings → System → KOReader Sync**,
   * for whoever is holding it — or why we can't say yet.
   *
   * Pushed to the device rather than read off the screen (`configureReader()`
   * in `src/sync/engine.ts`); this is only the values, so the piece that knows
   * the credentials stays the piece that issues them.
   *
   * `serverId` overrides to one server from the holder's list; omitted or
   * unknown, it falls back to their default. An unknown id is not an error
   * because a server can be deleted while a reader is offline.
   */
  readerSettings(
    userId: string | null,
    serverId?: string | null,
  ):
    | { ok: true; server: SyncServer; settings: DeviceKosyncSettings }
    | { ok: false; reason: string } {
    if (!userId || !this.users.some((u) => u.id === userId)) {
      return { ok: false, reason: "nobody is holding this reader" };
    }
    const server = this.server(userId, serverId) ?? this.defaultServer(userId);
    if (!server) return { ok: false, reason: "nobody is holding this reader" };
    if (!server.available) return { ok: false, reason: server.reason ?? "that sync server is off" };
    return {
      ok: true,
      server,
      settings: {
        koUsername: server.username,
        koPassword: server.password,
        koServerUrl: server.url,
        // Binary: the reader hashes the file it holds. Both MD5s of the bytes
        // we deliver are recorded at upload time, so a content hash resolves to
        // the right book — a filename match would break on the next retitle.
        koMatchMethod: 1,
      },
    };
  }

  /**
   * Ours, resolved now. Unavailable is still a row: "off in Settings" and "no
   * LAN address" are the two reasons page sync silently does nothing, and both
   * need somewhere to be said.
   */
  #localServer(userId: string): SyncServer {
    const cfg = this.config.current.kosync;
    const url = this.url();
    const { username, password } = this.credentials(userId);
    return {
      id: LOCAL_SYNC_SERVER_ID,
      name: "This computer",
      url: url ?? "",
      username,
      password,
      builtin: true,
      adopted: false,
      available: cfg.enabled && url !== null,
      reason: !cfg.enabled
        ? "Pocket Sync's own sync server is turned off in Settings"
        : url === null
        ? "this machine has no LAN address the reader could reach"
        : undefined,
    };
  }

  #writeServers(userId: string, fn: (list: SyncServerConfig[]) => SyncServerConfig[]) {
    this.config.update({
      users: this.users.map((u) =>
        u.id === userId ? { ...u, syncServers: fn(u.syncServers ?? []) } : u
      ),
    });
  }

  /** Drop a departed user's credentials. */
  forgetUser(userId: string) {
    for (
      const row of this.db.all<{ username: string }>(
        "SELECT username FROM kosync_user WHERE user_id = ?",
        userId,
      )
    ) {
      this.db.run("DELETE FROM setting WHERE key = ?", `kosync.password.${row.username}`);
    }
    this.db.run("DELETE FROM kosync_user WHERE user_id = ?", userId);
  }

  /** Short and typeable — this gets entered on an e-reader keyboard. */
  #allocateUsername(userId: string): string {
    const name = this.users.find((u) => u.id === userId)?.name ?? "";
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "reader";
    for (let n = 0;; n++) {
      const candidate = n === 0 ? base : `${base}${n + 1}`;
      const taken = this.db.get(
        "SELECT 1 AS x FROM kosync_user WHERE username = ?",
        candidate,
      );
      if (!taken) return candidate;
    }
  }

  #password(username: string): string | undefined {
    return this.db.get<{ value: string }>(
      "SELECT value FROM setting WHERE key = ?",
      `kosync.password.${username}`,
    )?.value;
  }

  /** Returns the user these credentials belong to, or null. */
  #authorize(req: Request): string | null {
    const user = req.headers.get("x-auth-user");
    const key = req.headers.get("x-auth-key");
    if (!user || !key) return null;
    const row = this.db.get<{ key_md5: string; user_id: string | null }>(
      "SELECT key_md5, user_id FROM kosync_user WHERE username = ?",
      user,
    );
    if (!row || row.key_md5.toLowerCase() !== key.toLowerCase()) return null;
    return row.user_id;
  }

  handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/healthz") return json({ state: "OK" });

    // Accepted so a reader's "register" flow succeeds, but it only ever confirms
    // a username we already generated for a folder — it never creates one.
    if (req.method === "POST" && path === "/users/create") {
      const { username } = await req.json().catch(() => ({ username: "" }));
      const known = this.db.get("SELECT 1 AS x FROM kosync_user WHERE username = ?", username);
      return known
        ? json({ username }, 201)
        : json({ message: "Account creation is disabled; use the credentials in Settings" }, 402);
    }

    const userId = this.#authorize(req);
    if (!userId) {
      return json({ message: "Unauthorized" }, 401);
    }

    if (req.method === "GET" && path === "/users/auth") {
      return json({ authorized: "OK" });
    }

    if (req.method === "PUT" && path === "/syncs/progress") {
      const payload = await req.json().catch(() => null) as ProgressPayload | null;
      if (!payload?.document) return json({ message: "document is required" }, 400);
      // The user comes from the credentials, never from the reported device
      // name — see `credentials()`. The device is recorded for display only.
      const deviceId = this.#deviceFor(payload);
      const { bookId } = this.reading.record(payload, userId, deviceId);
      if (!bookId) {
        // A side-loaded book: on the reader, but not one we sent, so its hash
        // maps to nothing. Keep the position against the hash itself — being a
        // sync server for the whole device costs one row, and dropping it is
        // indistinguishable from page sync being broken, since the reader is
        // answered either way.
        this.reading.recordUnmapped(payload, userId, deviceId);
        this.log.info(
          "kosync.unmapped",
          `Saved a position from ${payload.device ?? "a reader"} in a book Pocket Sync did not ` +
            `send it (document ${payload.document}) — it syncs, but has no shelf entry`,
        );
      }
      return json({
        document: payload.document,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }

    if (req.method === "GET" && path.startsWith("/syncs/progress/")) {
      const document = decodeURIComponent(path.slice("/syncs/progress/".length));
      const bookId = this.reading.bookForDocument(document);
      // Scoped to the authenticated user, so one reader can never pull back
      // another household member's position for the same book.
      const state = bookId ? this.reading.get(userId, bookId) : undefined;
      // A book we sent, or a side-loaded one kept against its hash alone. Both
      // answer the reader with its own position; only the first has a shelf
      // entry to show it on.
      const stored = state ?? this.reading.unmapped(userId, document);
      if (!stored) {
        // An empty body is the protocol's "no position stored", and the reader
        // renders it as page one reported by nobody. That is the shape of every
        // failure upstream of here, so say which one it was.
        this.log.info(
          "kosync.no-progress",
          bookId
            ? `No stored position yet for the book behind document ${document}`
            : `A reader asked for a position in document ${document}, which nothing has ` +
              `reported on yet`,
          { bookId: bookId ?? undefined },
        );
        return json({});
      }
      const report = storedReport(
        "position_json" in stored ? stored.position_json : stored.payload_json,
      );
      return json({
        document,
        percentage: stored.percentage,
        // Verbatim, because only the reader knows how to read its own locator.
        progress: report.progress ?? report.position?.xpath ?? "",
        position: report.position,
        // Which reader was last there, as it named itself — this is printed on
        // the device ("updated by …"), so our own name would be a lie and a
        // missing one prints as "null".
        device: report.device ?? "Pocket Sync",
        device_id: report.device_id ?? stored.device_id ?? "pocket-sync",
        timestamp: Math.floor(new Date(stored.updated_at).getTime() / 1000),
      });
    }

    return json({ message: "not found" }, 404);
  };

  /**
   * Best-effort match of the reporting reader to one of our devices, purely so
   * the UI can say where a position came from. Attribution never depends on it.
   */
  #deviceFor(payload: ProgressPayload): string | null {
    const name = (payload.device ?? "").toLowerCase();
    const id = (payload.device_id ?? "").toLowerCase();
    for (const d of this.devices.view()) {
      if (!d.id) continue;
      if (id && (d.id.toLowerCase() === id || (d.name ?? "").toLowerCase() === id)) return d.id;
      if (name && (d.name ?? "").toLowerCase() === name) return d.id;
    }
    return null;
  }

  /**
   * Start, stop or move the listener to match `config.kosync`.
   *
   * Called at startup and again whenever the settings change, so the switch and
   * the port take effect while the user is looking at them rather than after a
   * restart. Binding is what can fail here — a taken port is reported and
   * leaves page sync off, which the Settings page then shows as the reason
   * readers are not reporting.
   */
  async applyConfig(): Promise<void> {
    const { enabled, port, host } = this.config.current.kosync;
    if (this.#at?.port === port && this.#at.host === host && enabled === !!this.#server) return;
    await this.stop();
    if (!enabled) {
      this.log.info("kosync.stopped", "Pocket Sync's own sync server is off");
      return;
    }
    try {
      this.#server = Deno.serve({
        port,
        hostname: host,
        onListen: ({ hostname, port }) =>
          this.log.info(
            "kosync.listen",
            `KOReader sync server on http://${hostname}:${port} — readers are pointed at it ` +
              `automatically when they sync`,
          ),
      }, this.handler);
      this.#at = { port, host };
    } catch (err) {
      this.#at = null;
      this.log.error(
        "kosync.listen.failed",
        `Could not start the sync server on ${host}:${port} — ${err}`,
      );
    }
  }

  async stop() {
    await this.#server?.shutdown();
    this.#server = null;
    this.#at = null;
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function md5Hex(s: string): string {
  return createHash("md5").update(s).digest("hex");
}
