import type { ConfigStore, LibraryConfig } from "../core/config.ts";
import type { Db } from "../core/db.ts";
import type { EventBus } from "../core/events.ts";
import { md5File } from "../core/hash.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { Books } from "./books.ts";
import type { Imports } from "./imports.ts";
import {
  ACCEPTED_EXTS,
  basenameOf,
  editionKey,
  extOf,
  formatRank,
  ImportBlocked,
  type Ingest,
} from "./ingest.ts";
import { sourceById } from "./sources.ts";

/** Partial downloads and editor droppings, never books. */
const IGNORED_SUFFIXES = [".part", ".crdownload", ".download", ".tmp", ".!ut"];
const IGNORED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export interface ScanResult {
  libraryId: string;
  found: number;
  added: number;
  removed: number;
  deferred: number;
  /** Set when the folder could not be read — callers must not treat this as
   * "the library is empty", which would delete everything off a device. */
  unreadable?: string;
  /** Set when the folder was removed while the scan was running. */
  cancelled?: boolean;
}

export interface SeenFile {
  path: string;
  size: number;
  mtime: number;
}

/**
 * Watches the configured folders and keeps the index in step with them.
 *
 * The filesystem is the source of truth (docs/DESIGN.md): this class only ever
 * reads. Everything it derives lands in the app's own data dir.
 */
export class Scanner {
  #timer: ReturnType<typeof setInterval> | undefined;
  #watchers: Deno.FsWatcher[] = [];
  #pending = new Map<string, ReturnType<typeof setTimeout>>();
  #inflight = new Map<string, Promise<ScanResult>>();
  #followUp = new Map<string, Promise<ScanResult>>();
  #cancelled = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly books: Books,
    private readonly paths: Paths,
    private readonly ingest: Ingest,
    private readonly imports: Imports,
    private readonly log: Logger,
    private readonly bus: EventBus,
  ) {}

  get libraries(): LibraryConfig[] {
    return this.config.current.libraries ?? [];
  }

  library(id: string): LibraryConfig | undefined {
    return this.libraries.find((l) => l.id === id);
  }

  /** Every folder this device syncs. A device may hold several. */
  librariesForDevice(deviceId: string): LibraryConfig[] {
    return this.libraries.filter((l) => l.deviceIds.includes(deviceId));
  }

  start() {
    this.reconcile();
    this.scanAll().catch((err) => this.log.error("scan.failed", `Initial scan failed: ${err}`));
    this.#watch();
    const everyMs = Math.max(30, this.config.current.scan.intervalSec) * 1000;
    this.#timer = setInterval(() => {
      this.scanAll().catch((err) => this.log.error("scan.failed", `Rescan failed: ${err}`));
    }, everyMs);
  }

  stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const w of this.#watchers) {
      try {
        w.close();
      } catch { /* already closed */ }
    }
    this.#watchers = [];
    for (const t of this.#pending.values()) clearTimeout(t);
    this.#pending.clear();
  }

  /** Re-attach watchers, e.g. after the user edits the folder list. */
  restart() {
    this.stop();
    this.start();
  }

  /**
   * Stop work on a folder the user is removing.
   *
   * Must be called *before* the folder's rows are deleted: a scan already in
   * flight keeps hashing and converting, and every file it finishes re-inserts
   * the `library_book` row the deletion just removed. Cancelling first means the
   * in-flight pass bails at its next file instead of undoing the cleanup.
   */
  forget(libraryId: string) {
    this.#cancelled.add(libraryId);
    const timer = this.#pending.get(libraryId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#pending.delete(libraryId);
    }
    this.#followUp.delete(libraryId);
  }

  /**
   * Bring the index back in line with the configured folders. Run at startup.
   *
   * The database is a cache, not the truth, so anything it holds for a folder
   * that is no longer configured is garbage. Orphans arise from more than bugs:
   * `config.json` is meant to be hand-editable, and deleting a `libraries` entry
   * there never goes through the API's cleanup path at all.
   */
  reconcile(): {
    orphanRows: number;
    staleJobs: number;
    purgedBooks: number;
    orphanDirs: number;
    deadPins: number;
  } {
    const known = new Set(this.libraries.map((l) => l.id));
    const placeholder = known.size ? [...known].map(() => "?").join(",") : "''";
    const args = known.size ? [...known] : [];

    let orphanRows = 0;
    // `device_pin` is deliberately not in this list: it sweeps by `library_id`,
    // and a send names a reader and a book, never a folder. Its own sweep is
    // below, keyed on the book having left the library entirely.
    for (const table of ["library_book", "file_index", "import_job"]) {
      const doomed = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE library_id NOT IN (${placeholder})`,
        ...args,
      )!.n;
      if (doomed) {
        this.db.run(
          `DELETE FROM ${table} WHERE library_id NOT IN (${placeholder})`,
          ...args,
        );
        orphanRows += doomed;
      }
    }

    // Nothing can still be importing at startup, so a `running` job is a
    // leftover from a killed process. Drop it; the file gets picked up again.
    const staleJobs = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM import_job WHERE state = 'running'",
    )!.n;
    if (staleJobs) this.db.run("DELETE FROM import_job WHERE state = 'running'");

    // A send is an instruction about a file. Once no folder holds that file
    // there is nothing to send and nothing to un-send, so the row goes — the
    // same rule the desired-set query applies live, repeated here to clear the
    // rows themselves rather than just ignore them.
    const deadPins = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM device_pin WHERE book_id NOT IN (SELECT book_id FROM library_book)",
    )!.n;
    if (deadPins) {
      this.db.run(
        "DELETE FROM device_pin WHERE book_id NOT IN (SELECT book_id FROM library_book)",
      );
    }

    // Books no folder holds and no device carries: their derived artifacts are
    // dead weight on disk. Reading state is keyed separately and deliberately
    // survives, so re-adding the file restores where you were.
    const stranded = this.db.all<{ id: string }>(
      `SELECT id FROM book
       WHERE id NOT IN (SELECT book_id FROM library_book)
         AND id NOT IN (SELECT book_id FROM device_content)
         AND id NOT IN (SELECT book_id FROM device_pin)`,
    );
    for (const row of stranded) this.books.purge(row.id);

    const orphanDirs = this.#sweepArtifacts();

    if (orphanRows || staleJobs || stranded.length || orphanDirs || deadPins) {
      this.log.info(
        "index.reconciled",
        `Cleaned the index: ${orphanRows} row(s) for folders no longer watched, ` +
          `${staleJobs} interrupted import(s), ${stranded.length} unreferenced book(s), ` +
          `${orphanDirs} leftover artifact folder(s), ${deadPins} send(s) for missing files`,
        { detail: { orphanRows, staleJobs, purgedBooks: stranded.length, orphanDirs, deadPins } },
      );
    }
    return { orphanRows, staleJobs, purgedBooks: stranded.length, orphanDirs, deadPins };
  }

  /**
   * Delete derived-artifact directories with no book row.
   *
   * `Books.purge()` removes the directory alongside the row, but a row that goes
   * away by any other route — a cancelled import, a hand-edited database, an
   * older version's cleanup — leaves the directory behind where nothing else
   * will ever look at it. Cheap to sweep, and it only grows otherwise.
   */
  #sweepArtifacts(): number {
    const live = new Set(this.db.all<{ id: string }>("SELECT id FROM book").map((r) => r.id));
    let removed = 0;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(this.paths.libraryDir)];
    } catch {
      return 0; // nothing derived yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory || live.has(entry.name)) continue;
      try {
        Deno.removeSync(`${this.paths.libraryDir}/${entry.name}`, { recursive: true });
        removed++;
      } catch (err) {
        this.log.debug("index.sweep.failed", `Could not remove ${entry.name}: ${err}`);
      }
    }
    return removed;
  }

  async scanAll(): Promise<ScanResult[]> {
    const out: ScanResult[] = [];
    for (const lib of this.libraries) out.push(await this.scan(lib.id));
    this.imports.prune();
    return out;
  }

  /**
   * Reconcile one folder with the index. Never runs twice at once for the same
   * library; triggers arriving mid-scan coalesce into a single follow-up pass
   * and every caller gets that pass's result.
   *
   * Callers must never be handed "0 files" merely because a scan was already in
   * progress — the sync engine treats an empty folder as a reason to delete.
   */
  scan(libraryId: string): Promise<ScanResult> {
    if (this.#cancelled.has(libraryId)) {
      return Promise.resolve({
        libraryId,
        found: 0,
        added: 0,
        removed: 0,
        deferred: 0,
        cancelled: true,
      });
    }
    const running = this.#inflight.get(libraryId);
    if (!running) return this.#begin(libraryId);

    let queued = this.#followUp.get(libraryId);
    if (!queued) {
      queued = running.catch(() => {}).then(() => {
        this.#followUp.delete(libraryId);
        return this.#begin(libraryId);
      });
      this.#followUp.set(libraryId, queued);
    }
    return queued;
  }

  #begin(libraryId: string): Promise<ScanResult> {
    const job = this.#scan(libraryId).finally(() => {
      this.#inflight.delete(libraryId);
      // A scan that finished normally can still have raced a removal, since the
      // last file's rows land after the cancellation check.
      if (this.#cancelled.has(libraryId)) this.#purge(libraryId);
    });
    this.#inflight.set(libraryId, job);
    return job;
  }

  /** Drop everything the index holds for a folder we no longer watch. */
  #purge(libraryId: string) {
    this.db.run("DELETE FROM library_book WHERE library_id = ?", libraryId);
    this.db.run("DELETE FROM file_index WHERE library_id = ?", libraryId);
    this.db.run("DELETE FROM import_job WHERE library_id = ?", libraryId);
  }

  async #scan(libraryId: string): Promise<ScanResult> {
    const lib = this.library(libraryId);
    const result: ScanResult = { libraryId, found: 0, added: 0, removed: 0, deferred: 0 };
    if (!lib) return { ...result, unreadable: "no such library" };

    // An unreadable root must never be read as "zero books" — that is the path
    // to wiping a reader because an external drive was unplugged.
    try {
      const st = await Deno.stat(lib.path);
      if (!st.isDirectory) return { ...result, unreadable: `${lib.path} is not a folder` };
    } catch (err) {
      const msg = err instanceof Deno.errors.NotFound
        ? `folder not found: ${lib.path}`
        : `folder unreadable: ${err}`;
      this.log.warn("scan.unreadable", `Skipping “${lib.name}” — ${msg}`, {
        detail: { libraryId },
      });
      return { ...result, unreadable: msg };
    }

    let files: SeenFile[];
    try {
      // An external source knows which of its files are books; a plain watched
      // folder has no such rule and takes everything the extension check allows.
      files = await collect(lib.path, lib.sourceId ? sourceById(lib.sourceId)?.accepts : undefined);
    } catch (err) {
      return { ...result, unreadable: `walk failed: ${err}` };
    }
    result.found = files.length;

    const settleMs = Math.max(0, this.config.current.scan.settleSec) * 1000;
    const now = Date.now();
    const seen = new Set<string>();

    for (const group of groupEditions(files)) {
      // The user can remove a folder mid-scan — importing a big one takes
      // minutes. Stop here rather than finishing, and above all rather than
      // re-inserting rows the removal has already deleted.
      if (this.#cancelled.has(libraryId)) {
        this.log.info(
          "scan.cancelled",
          `Stopped scanning “${lib.name}” — the folder was removed`,
          { detail: { libraryId, added: result.added } },
        );
        // The file we were mid-conversion on when the removal landed has just
        // finished and written its rows. Clear up whatever this pass added, so
        // the outcome doesn't depend on where the cancellation fell.
        this.#purge(libraryId);
        return { ...result, cancelled: true };
      }

      // Still being written (or copied in): leave it for the next pass — the
      // whole edition, not just the unsettled file. A `.mobi` whose `.epub` is
      // still copying would otherwise import, then be superseded a minute
      // later: a book sent to the reader and deleted again for nothing.
      if (settleMs > 0 && group.some((f) => now - f.mtime < settleMs)) {
        for (const f of group) seen.add(f.path);
        result.deferred += group.length;
        continue;
      }

      // One book in several formats. `group` is best-first, so the first file
      // that lands wins and everything in a worse format is passed over —
      // deliberately left out of `seen`, so a row an earlier pass made for it
      // is reaped and the duplicate leaves the reader. Files of the *same*
      // rank are separate editions rather than alternative formats, so they
      // all still stand; and a format that cannot be imported (a DRM'd EPUB
      // beside a plain MOBI) falls through to the next best rather than
      // costing the book.
      let takenRank: number | null = null;
      for (const file of group) {
        const rank = formatRank(extOf(file.path));
        if (takenRank !== null && rank > takenRank) {
          this.log.debug(
            "scan.superseded",
            `Skipping ${basenameOf(file.path)} — already have this book in a better format`,
            { detail: { libraryId } },
          );
          break;
        }
        if (await this.#take(libraryId, file, seen, result)) takenRank = rank;
      }
    }

    result.removed = this.#reap(libraryId, seen);
    if (result.added || result.removed) {
      this.log.info(
        "scan.done",
        `Scanned “${lib.name}”: ${result.found} file(s), ${result.added} added, ` +
          `${result.removed} removed`,
        { detail: { libraryId } },
      );
    }
    return result;
  }

  /**
   * Index one file, importing it if it is new or has changed.
   *
   * Returns whether the file now stands for a book in this folder — false for a
   * blocked or failed import, which is what lets the caller fall back to
   * another format of the same title instead of losing it.
   */
  async #take(
    libraryId: string,
    file: SeenFile,
    seen: Set<string>,
    result: ScanResult,
  ): Promise<boolean> {
    seen.add(file.path);

    const known = this.db.get<{ size: number; mtime: number; md5: string }>(
      "SELECT size, mtime, md5 FROM file_index WHERE path = ?",
      file.path,
    );
    if (known && known.size === file.size && known.mtime === file.mtime) {
      // Unchanged. Make sure the membership row still exists (it won't after
      // a database reset) but skip the expensive work.
      this.books.addToLibrary(libraryId, known.md5, file.path);
      return true;
    }

    const job = this.imports.start(libraryId, file.path, basenameOf(file.path));
    try {
      this.imports.stage(job.id, "hashing");
      const md5 = await md5File(file.path);
      this.db.run(
        `INSERT INTO file_index (path, library_id, size, mtime, md5, seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (path) DO UPDATE SET
           library_id = excluded.library_id, size = excluded.size,
           mtime = excluded.mtime, md5 = excluded.md5, seen_at = excluded.seen_at`,
        file.path,
        libraryId,
        file.size,
        file.mtime,
        md5,
        new Date().toISOString(),
      );

      const book = await this.ingest.addFromPath(
        libraryId,
        file.path,
        md5,
        (stage) => this.imports.stage(job.id, stage),
      );
      this.imports.done(job.id, book.id);
      result.added++;
      this.bus.emit({
        level: "info",
        event: "ingest.done",
        message: `Added “${book.title}”`,
        bookId: book.id,
        detail: { libraryId },
      });
      return true;
    } catch (err) {
      // Blocked imports wait in the Inbox for the user; failures are final
      // until something changes on disk.
      if (err instanceof ImportBlocked) {
        this.imports.block(job.id, err.needs, err.message);
      } else {
        this.imports.fail(job.id, String(err instanceof Error ? err.message : err));
      }
      // Forget the hash so resolving the block re-imports on the next scan.
      this.db.run("DELETE FROM file_index WHERE path = ?", file.path);
      this.bus.emit({
        level: err instanceof ImportBlocked ? "warn" : "error",
        event: "ingest.failed",
        message: `${basenameOf(file.path)}: ${err instanceof Error ? err.message : err}`,
        detail: { libraryId },
      });
      return false;
    }
  }

  /**
   * Forget files that are no longer in the folder. A book leaves the library
   * only when no remaining file in it carries that content hash, so renaming or
   * moving a book within the folder is a no-op rather than a delete-and-resend.
   */
  #reap(libraryId: string, seen: Set<string>): number {
    const indexed = this.db.all<{ path: string; md5: string }>(
      "SELECT path, md5 FROM file_index WHERE library_id = ?",
      libraryId,
    );
    const goneHashes = new Set<string>();
    let removed = 0;
    for (const row of indexed) {
      if (seen.has(row.path)) continue;
      this.db.run("DELETE FROM file_index WHERE path = ?", row.path);
      this.imports.removeByPath(row.path);
      goneHashes.add(row.md5);
    }
    for (const md5 of goneHashes) {
      const stillHere = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM file_index WHERE library_id = ? AND md5 = ?",
        libraryId,
        md5,
      )!.n;
      if (stillHere > 0) continue;
      this.books.removeFromLibrary(libraryId, md5);
      removed++;
    }
    return removed;
  }

  /** Watch each folder, debounced — a copy of 40 books fires a lot of events. */
  #watch() {
    for (const lib of this.libraries) {
      let watcher: Deno.FsWatcher;
      try {
        watcher = Deno.watchFs(lib.path, { recursive: true });
      } catch (err) {
        this.log.warn(
          "scan.watch.failed",
          `Cannot watch “${lib.name}” (${lib.path}): ${err} — falling back to periodic rescan`,
        );
        continue;
      }
      this.#watchers.push(watcher);
      (async () => {
        for await (const _event of watcher) this.#debounce(lib.id);
      })().catch(() => {/* watcher closed */});
    }
  }

  #debounce(libraryId: string) {
    const existing = this.#pending.get(libraryId);
    if (existing !== undefined) clearTimeout(existing);
    this.#pending.set(
      libraryId,
      setTimeout(() => {
        this.#pending.delete(libraryId);
        this.scan(libraryId).catch((err) =>
          this.log.error("scan.failed", `Scan of ${libraryId} failed: ${err}`)
        );
      }, 1500),
    );
  }
}

/**
 * Gather the files that are one book in several formats.
 *
 * `Dune.epub` and `Dune.mobi` are the same book, and nothing downstream can
 * tell: content hashing sees two different files, so both import, both convert,
 * both go to the reader and the title appears twice on its shelf. Grouping by
 * `editionKey()` and keeping only the best format is the only place this can be
 * caught cheaply — before the MOBI is hashed and run through `ebook-convert`.
 *
 * Each group comes back sorted best-format-first, ties broken by path so a
 * rescan makes the same choice every time — otherwise directory order decides,
 * and the book on the reader churns between formats. Grouping is per-scan and
 * therefore per-folder: two folders holding different formats of one book stay
 * independent, which is what invariant 5 (a device's set is the union of its
 * folders) needs — the union is deduplicated by MD5 later.
 */
export function groupEditions(files: SeenFile[]): SeenFile[][] {
  const groups = new Map<string, SeenFile[]>();
  for (const file of files) {
    const key = editionKey(file.path);
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      group.sort((a, b) =>
        formatRank(extOf(a.path)) - formatRank(extOf(b.path)) || (a.path < b.path ? -1 : 1)
      );
    }
  }
  return [...groups.values()];
}

/**
 * Recursive walk, skipping dot-directories and non-book files.
 *
 * `accepts` is the per-source filter for external libraries, applied *in
 * addition* to the extension check — without it a Calibre library indexes its
 * `.original_epub` conversion backups as separate books.
 */
async function collect(
  root: string,
  accepts?: (relPath: string) => boolean,
): Promise<SeenFile[]> {
  const out: SeenFile[] = [];
  const stack: [string, string][] = [[root, ""]];
  while (stack.length) {
    const [dir, rel] = stack.pop()!;
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name.startsWith(".")) continue;
      const path = `${dir}/${entry.name}`;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        stack.push([path, childRel]);
        continue;
      }
      if (!entry.isFile) continue;
      if (IGNORED_NAMES.has(entry.name)) continue;
      if (IGNORED_SUFFIXES.some((s) => entry.name.toLowerCase().endsWith(s))) continue;
      if (!ACCEPTED_EXTS.includes(extOf(entry.name))) continue;
      if (accepts && !accepts(childRel)) continue;
      try {
        const st = await Deno.stat(path);
        out.push({ path, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
      } catch { /* vanished between readDir and stat */ }
    }
  }
  return out;
}
