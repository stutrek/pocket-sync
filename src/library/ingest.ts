import type { Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import type { Book, Books } from "./books.ts";
import { type BookMetadata, type Calibre, metadataFromFilename } from "./calibre.ts";
import type { Dedrm } from "./dedrm.ts";
import { detectDrm } from "./drm.ts";
import type { JobNeeds } from "./imports.ts";

/**
 * An import that cannot finish until the user supplies something. Distinct from
 * a failure: the job waits in the Inbox instead of being written off.
 */
export class ImportBlocked extends Error {
  constructor(readonly needs: JobNeeds, message: string) {
    super(message);
    this.name = "ImportBlocked";
  }
}

/** Anything `ebook-convert` handles; the device only reads EPUB. */
export const ACCEPTED_EXTS = [
  "epub",
  "txt",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "html",
  "htm",
  "md",
  "markdown",
  "docx",
  "rtf",
  "pdf",
  "lit",
  "pdb",
  "prc",
  "cbz",
  "cbr",
  // Not a book but a fulfillment token — accepted so the Inbox can say so
  // instead of silently ignoring the file.
  "acsm",
  // Kindle KFX. Nothing can remove its DRM (docs/DESIGN.md), so these are
  // accepted only so the Inbox can say so — same reasoning as .acsm. Silence is
  // the worst possible answer when someone drops one in.
  "kfx",
  "kfx-zip",
  "azw8",
];

/**
 * Which format of the same book to prefer, best first.
 *
 * The device only reads EPUB, so this is really "how much is lost getting
 * there": an EPUB needs no conversion at all, the Kindle formats reflow
 * cleanly, and a PDF is the last real choice because its fixed layout converts
 * badly. The tokens at the end are not books — a `.acsm` next to a book is the
 * receipt that fetched it, and KFX is a dead end — so they win only when
 * nothing else carries the same title, which is what keeps them visible in the
 * Inbox rather than silently dropped.
 *
 * Anything not listed sorts last but still ahead of nothing.
 */
const FORMAT_ORDER = [
  "epub",
  "azw3",
  "mobi",
  "azw",
  "prc",
  "pdb",
  "lit",
  "fb2",
  "cbz",
  "cbr",
  "docx",
  "rtf",
  "html",
  "htm",
  "md",
  "markdown",
  "pdf",
  "txt",
  "acsm",
  "kfx",
  "kfx-zip",
  "azw8",
];

export type Stage = "hashing" | "drm" | "metadata" | "converting" | "ready";

export function extOf(pathOrName: string): string {
  const base = pathOrName.replace(/\\/g, "/").split("/").pop() ?? "";
  return (base.includes(".") ? base.split(".").pop() ?? "" : "").toLowerCase();
}

export function basenameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

/** Lower is better. Equal ranks are the same format and never supersede. */
export function formatRank(ext: string): number {
  const i = FORMAT_ORDER.indexOf(ext.toLowerCase());
  return i === -1 ? FORMAT_ORDER.length : i;
}

/**
 * What two files share when they are one book in two formats.
 *
 * Content hashing cannot see this: `Dune.epub` and `Dune.mobi` are the same
 * book but not the same bytes, so both import and the reader shows the title
 * twice. The filename is the only evidence available before conversion, and
 * every layout that produces these pairs preserves it — Calibre keeps its
 * formats side by side as `Title - Author.epub|.mobi`, a download folder gets
 * both from the same purchase, and a library split into `epub/` and `mobi/`
 * trees repeats the name in each. So the key ignores the directory.
 *
 * Punctuation and case are normalized because the same name reaches disk
 * spelled differently, but nothing more aggressive: two *editions* of one title
 * are also a real thing, and they are told apart by extension rather than here
 * (see `groupEditions()`).
 */
export function editionKey(pathOrName: string): string {
  const name = basenameOf(pathOrName);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const key = stem.toLowerCase().replace(/[_\s]+/g, " ").trim();
  return key || name.toLowerCase();
}

/**
 * Why an import failed, read out of Calibre's output.
 *
 * Everything that goes wrong late — a book DeDRM could not open, a DRM format
 * it does not support, Calibre holding its own database — arrives here as the
 * same thing: a Python traceback from a subprocess. Told apart they have
 * completely different answers; left alone they all read as "conversion is
 * broken". Pure and exported so the patterns are tested against captured output
 * rather than by arranging the failures.
 */
export function classifyImportFailure(
  message: string,
): "calibre-busy" | "drm-kfx" | "drm-key" | null {
  // Calibre's GUI takes an exclusive lock and `calibredb` then refuses to run at
  // all — including against the throwaway library we make for ourselves.
  // Nothing is wrong with the book, so this must not read as a DRM problem.
  if (/Another calibre program|Having multiple/i.test(message)) return "calibre-busy";

  // Amazon's current KFX voucher format. DeDRM's last release predates it and
  // the project has been dormant since 2024, so no key and no plugin will help.
  if (
    /VoucherEnvelope|KFXDRMError|Book container .* has DRM|Failed to decrypt KFX DRM voucher/i
      .test(message)
  ) return "drm-kfx";

  if (/DRMError|has DRM|still (?:be )?DRM|Ultimately failed to decrypt/i.test(message)) {
    return "drm-key";
  }
  return null;
}

const FAILURE_MESSAGES: Record<"calibre-busy" | "drm-kfx", string> = {
  "calibre-busy": "Calibre is open, and it locks its database while running. " +
    "Quit Calibre and retry.",
  "drm-kfx": "Kindle KFX — Amazon's current DRM format is not one DeDRM can open. " +
    "Nothing to configure; this is a limit of the tools, not your setup.",
};

export class Ingest {
  constructor(
    private readonly db: Db,
    private readonly paths: Paths,
    private readonly books: Books,
    private readonly calibre: Calibre,
    private readonly dedrm: Dedrm,
    private readonly log: Logger,
  ) {}

  /**
   * Index a file that lives in the user's folder. The source is read, never
   * written or moved — every artifact we derive lands in our own data dir,
   * keyed by the content hash (docs/DESIGN.md).
   *
   * Optimization is deliberately *not* done here: it is per-device-profile and
   * happens lazily at sync time.
   */
  async addFromPath(
    libraryId: string,
    sourcePath: string,
    md5: string,
    onStage: (stage: Stage) => void = () => {},
  ): Promise<Book> {
    const filename = basenameOf(sourcePath);
    const ext = extOf(filename);
    if (!ACCEPTED_EXTS.includes(ext)) {
      throw new Error(`Unsupported file type ".${ext}" (${filename})`);
    }

    // Identical content we have already processed: reuse the derived artifacts
    // wholesale. This is what makes two people keeping the same book cheap.
    const existing = this.books.get(md5);
    if (existing?.epub_path && (await exists(existing.epub_path))) {
      this.books.addToLibrary(libraryId, md5, sourcePath);
      onStage("ready");
      this.log.debug("ingest.dedupe", `“${existing.title}” already known by content`, {
        bookId: md5,
      });
      return existing;
    }

    const dir = this.paths.bookDir(md5);
    await Deno.mkdir(dir, { recursive: true });
    let scratch: string | null = null;

    try {
      // DRM has to be dealt with before anything else touches the file:
      // `ebook-convert` simply fails on a protected book, because Calibre's
      // file-type plugins only run on `calibredb add`.
      onStage("drm");
      const { drm, detail } = await detectDrm(sourcePath, ext);
      let readPath = sourcePath;
      if (drm) {
        // KFX is a dead end whatever the file is called: DeDRM cannot parse
        // Amazon's current voucher format at all. Say so rather than sending
        // the user off to hunt for a key that would not help.
        if (drm === "kfx") throw new ImportBlocked("drm-kfx", FAILURE_MESSAGES["drm-kfx"]);
        const status = await this.calibre.check();
        if (!status.db) {
          throw new ImportBlocked(
            "calibre",
            `${detail ?? "DRM-protected"} — install Calibre to import it`,
          );
        }
        if (status.dedrmDisabled) {
          throw new ImportBlocked(
            "drm-plugin-disabled",
            `${detail ?? "DRM-protected"} — the DeDRM plugin is switched off in Calibre`,
          );
        }
        if (!status.dedrm) {
          throw new ImportBlocked(
            "drm-plugin",
            `${detail ?? "DRM-protected"} — needs the DeDRM plugin in Calibre`,
          );
        }
        scratch = `${this.paths.tmpDir}/import-${md5.slice(0, 12)}`;
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
        try {
          readPath = await this.calibre.importWithPlugins(readPath, scratch);
        } catch (err) {
          this.log.debug(
            "ingest.drm.failed",
            `Could not decrypt ${filename}: ${err instanceof Error ? err.message : err}`,
            { bookId: md5 },
          );
          // Same classification as a conversion failure: "unsupported DRM
          // format" and "no key that fits" look identical from here unless the
          // plugin's own output is read, and they have very different answers.
          throw await this.#classifyConversionFailure(err, detail);
        }
        this.log.info("ingest.drm", `Removed DRM from ${filename} via Calibre`, { bookId: md5 });
      }

      onStage("metadata");
      const coverPath = this.paths.cover(md5);
      let meta: BookMetadata = {};
      try {
        meta = await this.calibre.readMetadata(readPath, coverPath);
      } catch (err) {
        this.log.warn("ingest.meta.failed", `Metadata read failed for ${filename}: ${err}`, {
          bookId: md5,
        });
      }
      const fallback = metadataFromFilename(filename);
      const title = meta.title?.trim() || fallback.title || filename;
      const author = meta.author?.trim() || fallback.author || "Unknown";
      const hasCover = await exists(coverPath);

      const epubPath = this.paths.epub(md5);
      if (extOf(readPath) === "epub") {
        await Deno.copyFile(readPath, epubPath);
      } else {
        onStage("converting");
        const started = performance.now();
        try {
          await this.calibre.toEpub(readPath, epubPath);
        } catch (err) {
          // A book DeDRM could not open is added and exported by `calibredb`
          // regardless, still encrypted, and only fails here — as a Calibre
          // DRMError wrapped in a Python traceback. Left alone it reads as
          // "conversion is broken" rather than "this book is still locked".
          throw await this.#classifyConversionFailure(err, detail);
        }
        this.log.info(
          "ingest.convert.done",
          `Converted ${filename} to EPUB in ${((performance.now() - started) / 1000).toFixed(1)}s`,
          { bookId: md5 },
        );
      }
      const epubSize = (await Deno.stat(epubPath)).size;
      const sourceSize = (await Deno.stat(sourcePath)).size;

      this.db.run(
        `INSERT INTO book (id, title, author, series, series_index, added_at, cover_path,
                           original_ext, epub_path, size_bytes, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, author = excluded.author, series = excluded.series,
           series_index = excluded.series_index, cover_path = excluded.cover_path,
           epub_path = excluded.epub_path, size_bytes = excluded.size_bytes,
           meta_json = excluded.meta_json`,
        md5,
        title,
        author,
        meta.series ?? null,
        meta.seriesIndex ?? null,
        new Date().toISOString(),
        hasCover ? coverPath : null,
        ext,
        epubPath,
        sourceSize,
        JSON.stringify({ ...meta, originalFilename: filename, epubSize }),
      );
      this.books.addToLibrary(libraryId, md5, sourcePath);

      onStage("ready");
      this.log.info("ingest.done", `Added “${title}” by ${author}`, {
        bookId: md5,
        detail: { epubSize },
      });
      return this.books.get(md5)!;
    } catch (err) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      // A blocked import is waiting on the user, not broken — don't shout.
      if (err instanceof ImportBlocked) {
        this.log.info("ingest.blocked", `${filename}: ${err.message}`, { detail: { filename } });
      } else {
        this.log.error("ingest.failed", `Failed to ingest ${filename}: ${err}`, {
          detail: { filename },
        });
      }
      throw err;
    } finally {
      if (scratch) await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  }

  /**
   * Turn a conversion failure into something the user can act on.
   *
   * Anything still encrypted reaches `ebook-convert` and dies there, so this is
   * where several distinct problems all look identical unless they are told
   * apart.
   */
  async #classifyConversionFailure(err: unknown, detail?: string): Promise<Error> {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyImportFailure(message);
    if (!kind) return err instanceof Error ? err : new Error(message);

    if (kind === "drm-key") {
      const keys = await this.dedrm.summary().catch(() => null);
      const configured = keys ? keys.serials.length + keys.adobeKeys + keys.kindleKeys : 0;
      return new ImportBlocked(
        "drm-key",
        configured === 0
          ? `${detail ?? "DRM-protected"} — no reader key is configured yet`
          : `${detail ?? "DRM-protected"} — none of your ${configured} configured key` +
            `${configured === 1 ? "" : "s"} open it; it was probably bought on another account`,
      );
    }
    return new ImportBlocked(kind, FAILURE_MESSAGES[kind]);
  }

  /**
   * An upload is just a remote way to put a file in the watched folder — the
   * scanner picks it up from there like anything else the user dropped in.
   * Returns the path written.
   */
  async writeUpload(libraryDir: string, filename: string, data: Uint8Array): Promise<string> {
    const ext = extOf(filename);
    if (!ACCEPTED_EXTS.includes(ext)) {
      throw new Error(`Unsupported file type ".${ext}" (${filename})`);
    }
    const safe = basenameOf(filename).replace(/[/\\]/g, "_");
    let target = `${libraryDir}/${safe}`;
    // Don't clobber a file the user already has.
    if (await exists(target)) {
      const stem = safe.replace(/\.[^.]+$/, "");
      target = `${libraryDir}/${stem} (${Date.now()}).${ext}`;
    }
    await Deno.writeFile(target, data);
    this.log.info("upload.written", `Saved ${safe} into the watched folder`, {
      detail: { target },
    });
    return target;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile && st.size > 0;
  } catch {
    return false;
  }
}

export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}
