import type { Paths } from "./paths.ts";

/**
 * A watched folder. The folder is the library — we index it in place and never
 * write to it (docs/DESIGN.md). Defined here rather than in SQLite so it
 * survives a lost database and stays hand-editable.
 */
export interface LibraryConfig {
  id: string;
  name: string;
  /**
   * Absolute path. Inside `rootPath` unless `external` — see src/core/roots.ts
   * for the rule and the one exception to it.
   */
  path: string;
  /** Devices that sync this folder. Many-to-many: a device may sync several
   * folders, and a folder may feed several devices. */
  deviceIds: string[];
  /**
   * An existing e-reader library found elsewhere on this machine — a Calibre
   * library, Kindle for Mac's content folder, and so on. Set only by
   * `POST /api/sources/:id/enable`, which resolves the path **server-side** from
   * a fixed allowlist; no request body can produce one.
   */
  external?: boolean;
  /**
   * Never written to and never deleted from. Every external source is read-only,
   * which is what makes watching outside the root safe — see `assertWritable`
   * in src/web/server.ts. Deleting the *library* just stops watching it.
   */
  readOnly?: boolean;
  /** Which known source this came from (`calibre`, `kindle-mac`, …). */
  sourceId?: string;
}

/**
 * The id of the sync server we run ourselves. Reserved: it is never stored in
 * `UserConfig.syncServers`, because its URL is this machine's LAN address and
 * its credentials are generated — both of which move. It is resolved live by
 * `KosyncServer.servers()` and always sorts first.
 */
export const LOCAL_SYNC_SERVER_ID = "local";

/**
 * Somewhere a reader reports its reading position to.
 *
 * Only *other people's* servers are stored — a self-hosted kosync box, a
 * household member's Pocket Sync, the public KOReader server. Ours is synthetic
 * (`LOCAL_SYNC_SERVER_ID`). Entries arrive either because the user added one or
 * because a reader turned up already pointing at it, which we adopt rather than
 * overwrite (`SyncEngine.configureReader()`).
 */
export interface SyncServerConfig {
  id: string;
  /** For the UI only. Defaults to the URL's host when adopted from a reader. */
  name: string;
  url: string;
  username: string;
  password: string;
  /** Set when this came off a reader rather than from the user typing it. */
  adopted?: boolean;
}

/**
 * A person, for the purpose of keeping reading positions apart. Not an account —
 * there is no login. A device records which user is currently holding it, and
 * that is switchable (docs/DESIGN.md).
 */
export interface UserConfig {
  id: string;
  name: string;
  /**
   * Sync servers besides ours. Ours is always available and always listed
   * first, so an empty list is the normal case, not an unconfigured one.
   */
  syncServers?: SyncServerConfig[];
  /**
   * Which server this person's readers report to. Unset means ours. Applied
   * whenever a reader is handed to them, which is what makes "my books, my
   * server" hold across every reader they pick up.
   */
  defaultSyncServerId?: string;
}

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
  /**
   * The one top-level folder everything lives under, chosen once via a native
   * picker. Watched folders are addressed relative to it so no API can name a
   * path outside it — indexed files are readable and deletable, so an arbitrary
   * path would be an arbitrary-file API. Empty until chosen.
   */
  rootPath: string;
  /** People, so two readers of the same book keep separate positions. */
  users: UserConfig[];
  /** Watched folders. A folder can feed several devices, and a device can sync
   * several folders. */
  libraries: LibraryConfig[];
  kosync: {
    /**
     * Run *our* sync server. Off does not mean "no page sync": a person whose
     * default is somebody else's server still has their readers pointed at it.
     * It only withdraws ours from every user's list. Applied live.
     */
    enabled: boolean;
    /** Must be LAN-reachable for the reader — deliberately separate from the
     * library UI's listener so enabling it doesn't expose the library. */
    port: number;
    host: string;
  };
  opds: {
    /**
     * Serve the OPDS catalog, so a reader or a phone can browse the library and
     * pull books itself instead of waiting to be pushed.
     *
     * Off by default, and the only setting here that is. Page sync exposes
     * positions; this exposes the books — a request that reaches it can
     * download anything indexed, since there is no login (see `src/web/opds.ts`
     * for why that is the right trade for a household LAN). Turning that on is
     * the user's call to make, not ours to assume.
     */
    enabled: boolean;
    /** Its own listener, for the same reason page sync has one: the reader is
     * another machine, and the library *UI* must stay off the LAN. */
    port: number;
    host: string;
  };
  scan: {
    /** Backstop rescan interval. Filesystem events are unreliable on
     * Dropbox/iCloud/Syncthing folders, which is where book collections live. */
    intervalSec: number;
    /** A file must stop changing for this long before it is imported, so a
     * half-written download is never ingested. */
    settleSec: number;
  };
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
  rootPath: "",
  users: [],
  libraries: [],
  kosync: {
    // On by default: the reader has to be told our address by hand either way,
    // so there is nothing to gain from also making the server opt-in.
    enabled: true,
    port: 8788,
    host: "0.0.0.0",
  },
  opds: {
    enabled: false,
    port: 8789,
    host: "0.0.0.0",
  },
  scan: {
    intervalSec: 300,
    settleSec: 2,
  },
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
