import type { Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import { newId } from "../core/ids.ts";
import type { Book, Books } from "./books.ts";
import { type BookMetadata, type Calibre, metadataFromFilename } from "./calibre.ts";

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
];

export class Ingest {
  constructor(
    private readonly db: Db,
    private readonly paths: Paths,
    private readonly books: Books,
    private readonly calibre: Calibre,
    private readonly log: Logger,
  ) {}

  /**
   * Store an uploaded file, extract metadata, and normalize to EPUB.
   * Optimization is deliberately *not* done here — it is per-device-profile
   * and happens lazily at sync time (§6.4).
   */
  async addFile(filename: string, data: Uint8Array): Promise<Book> {
    const ext = (filename.split(".").pop() ?? "").toLowerCase();
    if (!ACCEPTED_EXTS.includes(ext)) {
      throw new Error(`Unsupported file type ".${ext}" (${filename})`);
    }

    const id = newId();
    const dir = this.paths.bookDir(id);
    await Deno.mkdir(dir, { recursive: true });

    try {
      const originalPath = this.paths.original(id, ext);
      await Deno.writeFile(originalPath, data);
      this.log.info("ingest.start", `Ingesting ${filename} (${fmtBytes(data.length)})`, {
        bookId: id,
        detail: { filename, ext },
      });

      const coverPath = this.paths.cover(id);
      let meta: BookMetadata = {};
      try {
        meta = await this.calibre.readMetadata(originalPath, coverPath);
      } catch (err) {
        this.log.warn("ingest.meta.failed", `Metadata read failed for ${filename}: ${err}`, {
          bookId: id,
        });
      }
      const fallback = metadataFromFilename(filename);
      // Formats without embedded metadata (PDF, TXT) make ebook-meta fall back
      // to the file's name — which here is our storage name, "original".
      // Ignore that and use the name the user actually uploaded.
      const derivedFromStorage = meta.title?.trim().toLowerCase() === "original";
      const title = (!derivedFromStorage && meta.title?.trim()) || fallback.title || filename;
      const author = meta.author?.trim() || fallback.author || "Unknown";
      const hasCover = await exists(coverPath);

      const epubPath = this.paths.epub(id);
      if (ext === "epub") {
        await Deno.copyFile(originalPath, epubPath);
      } else {
        const started = performance.now();
        await this.calibre.toEpub(originalPath, epubPath);
        this.log.info(
          "ingest.convert.done",
          `Converted ${filename} to EPUB in ${((performance.now() - started) / 1000).toFixed(1)}s`,
          { bookId: id },
        );
      }
      const epubSize = (await Deno.stat(epubPath)).size;

      this.db.run(
        `INSERT INTO book (id, title, author, series, series_index, added_at, cover_path,
                           original_path, original_ext, epub_path, size_bytes, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        title,
        author,
        meta.series ?? null,
        meta.seriesIndex ?? null,
        new Date().toISOString(),
        hasCover ? coverPath : null,
        originalPath,
        ext,
        epubPath,
        data.length,
        JSON.stringify({ ...meta, originalFilename: filename, epubSize }),
      );
      this.db.run(
        "INSERT INTO format (book_id, ext, path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        id,
        ext,
        originalPath,
      );
      if (ext !== "epub") {
        this.db.run(
          "INSERT INTO format (book_id, ext, path) VALUES (?, 'epub', ?) ON CONFLICT DO NOTHING",
          id,
          epubPath,
        );
      }

      this.log.info("ingest.done", `Added “${title}” by ${author}`, {
        bookId: id,
        detail: { epubSize },
      });
      return this.books.get(id)!;
    } catch (err) {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      this.log.error("ingest.failed", `Failed to ingest ${filename}: ${err}`, {
        detail: { filename },
      });
      throw err;
    }
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
