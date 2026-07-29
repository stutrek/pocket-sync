import { ConfigStore } from "./core/config.ts";
import { Db } from "./core/db.ts";
import { EventBus } from "./core/events.ts";
import { Logger } from "./core/log.ts";
import { defaultDataDir, Paths } from "./core/paths.ts";
import { canonical, commonAncestor, isInside, normalizePath } from "./core/roots.ts";
import { DeviceManager } from "./device/manager.ts";
import { Sidecar } from "./engine/sidecar.ts";
import { Books } from "./library/books.ts";
import { Calibre, type CalibreStatus } from "./library/calibre.ts";
import { Dedrm } from "./library/dedrm.ts";
import { Imports } from "./library/imports.ts";
import { Ingest } from "./library/ingest.ts";
import { Scanner } from "./library/scanner.ts";
import { SyncEngine } from "./sync/engine.ts";
import { Pins } from "./sync/pins.ts";
import { Profiles } from "./sync/profiles.ts";
import { KosyncServer } from "./sync/kosync.ts";
import { Reading } from "./sync/reading.ts";
import { OpdsServer } from "./web/opds.ts";

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
  readonly calibre: Calibre;
  /** Calibre's DeDRM key store. Read and appended to, never owned. */
  readonly dedrm: Dedrm;
  readonly imports: Imports;
  readonly ingest: Ingest;
  readonly scanner: Scanner;
  readonly sidecar: Sidecar;
  readonly profiles: Profiles;
  readonly devices: DeviceManager;
  readonly reading: Reading;
  readonly kosync: KosyncServer;
  readonly pins: Pins;
  readonly sync: SyncEngine;
  /** The OPDS catalog. Its own LAN listener, off unless the user turns it on. */
  readonly opds: OpdsServer;

  /**
   * Last dependency probe, surfaced in the UI so setup problems are visible.
   *
   * `checked` distinguishes "not probed yet" from "probed and missing". Without
   * it the pre-probe placeholder reads as "Calibre not found / resampling
   * unavailable", and the UI announces both for the first second or two of every
   * launch — which with `--watch` is constantly, and is simply untrue.
   */
  deps: {
    checked: boolean;
    calibre: CalibreStatus;
    engine: { ok: boolean; python?: string; bundled?: boolean; error?: string };
    checkedAt: string;
  } = {
    checked: false,
    calibre: {
      convert: false,
      meta: false,
      db: false,
      dedrm: false,
      dedrmDisabled: false,
      stalePlugins: [],
    },
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
    this.calibre = new Calibre(() => this.config.current);
    this.dedrm = new Dedrm(() => this.calibre.configDir());
    this.imports = new Imports(this.db);
    this.ingest = new Ingest(this.db, this.paths, this.books, this.calibre, this.dedrm, this.log);
    this.sidecar = new Sidecar(() => this.config.current, this.paths, this.log);
    this.scanner = new Scanner(
      this.db,
      this.config,
      this.books,
      this.paths,
      this.ingest,
      this.imports,
      this.log,
      this.bus,
    );
    this.profiles = new Profiles(this.db, this.paths, this.sidecar, this.log);
    this.devices = new DeviceManager(this.db, this.config, this.sidecar, this.log);
    this.reading = new Reading(this.db, this.log, this.bus);
    this.kosync = new KosyncServer(
      this.db,
      this.reading,
      this.devices,
      this.config,
      this.log,
    );
    this.pins = new Pins(this.db);
    this.sync = new SyncEngine(
      this.db,
      this.config,
      this.books,
      this.profiles,
      this.devices,
      this.sidecar,
      this.scanner,
      this.kosync,
      this.pins,
      this.log,
      this.bus,
    );
    this.opds = new OpdsServer(
      this.config,
      this.books,
      this.devices,
      this.sync,
      this.profiles,
      this.log,
    );
    // Closes the loop the constructors cannot: the catalog needs the engine, so
    // the engine is handed the catalog's URL afterwards instead.
    this.sync.catalogUrlFor = (id) => this.opds.catalogUrl(id);
    this.devices.onConnect = (id) => this.sync.onDeviceConnected(id);
  }

  /**
   * Give installations configured before roots existed a sensible root, rather
   * than invalidating folders the user already had. Runs once: the parent of the
   * folders they already watch.
   */
  #inferRoot() {
    const cfg = this.config.current;
    if (cfg.rootPath || !cfg.libraries.length) return;
    const root = commonAncestor(cfg.libraries.map((l) => l.path));
    if (!root) return;
    // Only adopt it if it really does contain everything.
    if (!cfg.libraries.every((l) => isInside(root, normalizePath(l.path)))) return;
    this.config.update({ rootPath: root });
    this.log.info(
      "root.inferred",
      `Library root set to ${root}, containing the ${cfg.libraries.length} folder(s) ` +
        `already configured`,
    );
  }

  /**
   * Rewrite stored paths to their on-disk form.
   *
   * macOS and Windows are case-insensitive but case-preserving, so a path typed
   * with the wrong case is accepted by the filesystem and then fails every
   * case-sensitive comparison we make against a resolved path — a folder ends up
   * looking like it is outside its own root. Canonicalising once at startup
   * keeps config and disk in agreement.
   */
  async #canonicalizePaths() {
    const cfg = this.config.current;
    const patch: { rootPath?: string; libraries?: typeof cfg.libraries } = {};

    if (cfg.rootPath) {
      const real = await canonical(cfg.rootPath);
      if (real && real !== normalizePath(cfg.rootPath)) patch.rootPath = real;
    }

    const libraries = await Promise.all(cfg.libraries.map(async (l) => {
      const real = await canonical(l.path);
      return real && real !== normalizePath(l.path) ? { ...l, path: real } : l;
    }));
    if (libraries.some((l, i) => l !== cfg.libraries[i])) patch.libraries = libraries;

    if (!patch.rootPath && !patch.libraries) return;
    this.config.update(patch);
    this.log.info(
      "paths.canonicalized",
      "Rewrote stored folder paths to match the filesystem's own spelling",
      { detail: { root: patch.rootPath ?? cfg.rootPath } },
    );
  }

  async start() {
    this.log.info("app.start", `Pocket Sync starting (data dir ${this.paths.dataDir})`);
    this.#inferRoot();
    await this.#canonicalizePaths();
    await this.sidecar.prepare();
    await this.checkDependencies();
    this.scanner.start();
    this.devices.start();
    // Devices registered before their model was known, or before resampling
    // defaulted, still have no profile. Fill those in now.
    this.sync.backfillProfiles();
    await this.kosync.applyConfig();
    await this.opds.applyConfig();
    // Re-identifies books already on a reader after a change to how document
    // hashes are computed. Reads every delivered file, so it runs alongside
    // startup rather than in front of it; page sync for books already on a
    // device simply starts working partway through.
    this.sync.remapDeliveredDocuments().catch((err) =>
      this.log.warn("kosync.remap.failed", `Could not re-identify delivered books: ${err}`)
    );
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

    this.deps = { checked: true, calibre, engine, checkedAt: new Date().toISOString() };
    // Tell the UI immediately rather than leaving it on the placeholder until
    // its next 15-second status poll.
    this.bus.emit({
      level: "debug",
      event: "deps.checked",
      message: "Dependency probe finished",
      detail: { calibre: calibre.convert, engine: engine.ok },
    });
    return this.deps;
  }

  status() {
    const devices = this.devices.view();
    return {
      dataDir: this.paths.dataDir,
      autoSyncEnabled: this.config.current.autoSyncEnabled,
      books: this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM library_book")!.n,
      libraries: this.config.current.libraries.map((l) => ({
        id: l.id,
        name: l.name,
        path: l.path,
        deviceIds: l.deviceIds,
        books: this.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM library_book WHERE library_id = ?",
          l.id,
        )!.n,
      })),
      users: this.config.current.users,
      inbox: this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM import_job WHERE state IN ('blocked','failed')",
      )!.n,
      devices: devices.length,
      devicesOnline: devices.filter((d) => d.state.online).length,
      lastSync: devices
        .map((d) => d.state.lastSyncAt)
        .filter(Boolean)
        .sort()
        .pop() ?? null,
      syncing: devices.some((d) => d.state.syncing),
      discovery: this.devices.discoveryStatus(),
      deps: this.deps,
    };
  }

  async stop() {
    this.scanner.stop();
    await this.kosync.stop();
    await this.opds.stop();
    this.devices.stop();
    await this.sidecar.stop();
    this.log.info("app.stop", "Pocket Sync stopped");
    this.log.close();
    this.db.close();
  }
}
