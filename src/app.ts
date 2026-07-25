import { ConfigStore } from "./core/config.ts";
import { Db } from "./core/db.ts";
import { EventBus } from "./core/events.ts";
import { Logger } from "./core/log.ts";
import { defaultDataDir, Paths } from "./core/paths.ts";
import { DeviceManager } from "./device/manager.ts";
import { Sidecar } from "./engine/sidecar.ts";
import { Books } from "./library/books.ts";
import { Calibre, type CalibreStatus } from "./library/calibre.ts";
import { Ingest } from "./library/ingest.ts";
import { Lists } from "./library/lists.ts";
import { SyncEngine } from "./sync/engine.ts";
import { Profiles } from "./sync/profiles.ts";

/**
 * Wires the services together. Deliberately free of any GUI dependency so the
 * same object graph runs headless (`deno task start`) or behind the tray.
 */
export class App {
  readonly paths: Paths;
  readonly config: ConfigStore;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly db: Db;
  readonly books: Books;
  readonly lists: Lists;
  readonly calibre: Calibre;
  readonly ingest: Ingest;
  readonly sidecar: Sidecar;
  readonly profiles: Profiles;
  readonly devices: DeviceManager;
  readonly sync: SyncEngine;

  /** Last dependency probe, surfaced in the UI so setup problems are visible. */
  deps: {
    calibre: CalibreStatus;
    engine: { ok: boolean; python?: string; bundled?: boolean; error?: string };
    checkedAt: string;
  } = {
    calibre: { convert: false, meta: false },
    engine: { ok: false },
    checkedAt: new Date(0).toISOString(),
  };

  constructor(dataDir = defaultDataDir()) {
    this.paths = new Paths(dataDir);
    this.paths.ensure();
    this.config = ConfigStore.load(this.paths);
    this.bus = new EventBus();
    this.log = new Logger(this.paths, this.bus);
    this.log.setLevel(this.config.current.logLevel);
    this.db = new Db(this.paths.db);

    this.books = new Books(this.db, this.paths);
    this.lists = new Lists(this.db);
    this.calibre = new Calibre(() => this.config.current);
    this.ingest = new Ingest(this.db, this.paths, this.books, this.calibre, this.log);
    this.sidecar = new Sidecar(() => this.config.current, this.paths, this.log);
    this.profiles = new Profiles(this.db, this.paths, this.sidecar, this.log);
    this.devices = new DeviceManager(this.db, this.config, this.sidecar, this.log);
    this.sync = new SyncEngine(
      this.db,
      this.config,
      this.books,
      this.profiles,
      this.devices,
      this.sidecar,
      this.log,
      this.bus,
    );
    this.devices.onConnect = (id) => this.sync.onDeviceConnected(id);
  }

  async start() {
    this.log.info("app.start", `Pocket Sync starting (data dir ${this.paths.dataDir})`);
    await this.sidecar.prepare();
    await this.checkDependencies();
    this.devices.start();
  }

  /**
   * Probe the external tools. Calibre is optional — EPUBs sync without it, so
   * a miss is a warning the UI shows, not a fatal error.
   */
  async checkDependencies() {
    const calibre = await this.calibre.check();
    if (calibre.convert) {
      this.log.info(
        "deps.calibre",
        `Calibre ready (${calibre.version ?? "unknown version"}) at ${calibre.convertPath}`,
      );
    } else {
      this.log.warn(
        "deps.calibre",
        "Calibre not found — EPUB books still sync, but other formats (MOBI, PDF, DOCX…) " +
          "need Calibre installed from calibre-ebook.com",
      );
    }

    const engine: { ok: boolean; python?: string; bundled?: boolean; error?: string } = {
      ok: false,
      bundled: this.sidecar.usingBundledPython,
    };
    try {
      const ping = await this.sidecar.ping();
      engine.python = ping.python;
      if (!ping.vendor) {
        engine.error = `engine modules missing: ${ping.vendorError ?? "unknown"}`;
      } else if (!ping.pillow || !ping.lxml) {
        engine.error = `Python ${ping.python} is missing ${!ping.pillow ? "Pillow " : ""}${
          !ping.lxml ? "lxml" : ""
        }`;
      } else {
        engine.ok = true;
      }
    } catch (err) {
      engine.error = String(err);
    }
    if (engine.ok) {
      this.log.info(
        "deps.engine",
        `Resampling engine ready (Python ${engine.python}${engine.bundled ? ", bundled" : ""})`,
      );
    } else {
      this.log.error("deps.engine", `Resampling unavailable: ${engine.error}`);
    }

    this.deps = { calibre, engine, checkedAt: new Date().toISOString() };
    return this.deps;
  }

  status() {
    const devices = this.devices.view();
    return {
      dataDir: this.paths.dataDir,
      autoSyncEnabled: this.config.current.autoSyncEnabled,
      books: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM book")!.n,
      lists: this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM "list"')!.n,
      devices: devices.length,
      devicesOnline: devices.filter((d) => d.state.online).length,
      lastSync: devices
        .map((d) => d.state.lastSyncAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null,
      syncing: devices.some((d) => d.state.syncing),
      deps: this.deps,
    };
  }

  async stop() {
    this.devices.stop();
    await this.sidecar.stop();
    this.log.info("app.stop", "Pocket Sync stopped");
    this.log.close();
    this.db.close();
  }
}
