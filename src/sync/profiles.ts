import { bit, type Db } from "../core/db.ts";
import { newId, shortHash } from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import { ENGINE_VERSION } from "../engine/assets.ts";
import type { Sidecar } from "../engine/sidecar.ts";
import type { Book } from "../library/books.ts";

export interface ResampleProfile {
  id: string;
  name: string;
  device_model: string;
  jpeg_quality: number;
  grayscale: number;
  auto_crop: number;
  split_text: number;
}

export interface OptimizeSummary {
  images?: number;
  cropped?: number;
  fixes?: number;
  errors?: number;
  orig_size?: number;
  new_size?: number;
  elapsed?: number;
  profileKey?: string;
}

/**
 * Cache key for an optimized EPUB. Includes the engine version so a bumped
 * upstream optimizer transparently invalidates every cached copy.
 */
export function profileHash(p: ResampleProfile): string {
  return shortHash(
    [
      p.device_model,
      p.jpeg_quality,
      p.grayscale,
      p.auto_crop,
      p.split_text,
      ENGINE_VERSION,
    ].join("|"),
  );
}

export class Profiles {
  /** In-flight optimizations, keyed by cache path, so concurrent syncs share work. */
  #inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Db,
    private readonly paths: Paths,
    private readonly sidecar: Sidecar,
    private readonly log: Logger,
  ) {}

  all(): ResampleProfile[] {
    return this.db.all<ResampleProfile>(
      "SELECT * FROM resample_profile ORDER BY name COLLATE NOCASE",
    );
  }

  get(id: string): ResampleProfile | undefined {
    return this.db.get<ResampleProfile>("SELECT * FROM resample_profile WHERE id = ?", id);
  }

  create(input: Partial<ResampleProfile> & { name: string }): ResampleProfile {
    const id = newId();
    this.db.run(
      `INSERT INTO resample_profile (id, name, device_model, jpeg_quality, grayscale, auto_crop, split_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name.trim(),
      (input.device_model ?? "X4").toUpperCase(),
      clamp(input.jpeg_quality ?? 85, 1, 100),
      bit(input.grayscale ?? 1),
      bit(input.auto_crop ?? 0),
      bit(input.split_text ?? 1),
    );
    return this.get(id)!;
  }

  update(id: string, input: Partial<ResampleProfile>): ResampleProfile | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db.run(
      `UPDATE resample_profile
       SET name = ?, device_model = ?, jpeg_quality = ?, grayscale = ?, auto_crop = ?, split_text = ?
       WHERE id = ?`,
      (input.name ?? cur.name).trim(),
      (input.device_model ?? cur.device_model).toUpperCase(),
      clamp(input.jpeg_quality ?? cur.jpeg_quality, 1, 100),
      bit(input.grayscale ?? cur.grayscale),
      bit(input.auto_crop ?? cur.auto_crop),
      bit(input.split_text ?? cur.split_text),
      id,
    );
    return this.get(id);
  }

  remove(id: string) {
    this.db.run("DELETE FROM resample_profile WHERE id = ?", id);
  }

  /**
   * Path of the EPUB to send for `book` under `profile`, producing and caching
   * the optimized copy on first use. A null profile means "send as converted".
   */
  async fileForSend(
    book: Book,
    profile: ResampleProfile | null,
    onProgress?: (tag: string, message: string) => void,
  ): Promise<{ path: string; optimized: boolean; summary?: OptimizeSummary }> {
    const source = book.epub_path;
    if (!source) throw new Error(`Book ${book.id} has no EPUB`);
    if (!profile) return { path: source, optimized: false };

    const hash = profileHash(profile);
    const target = this.paths.optimized(book.id, hash);
    try {
      const st = await Deno.stat(target);
      if (st.size > 0) return { path: target, optimized: true };
    } catch { /* not cached yet */ }

    const existing = this.#inflight.get(target);
    if (existing) return { path: await existing, optimized: true };

    const job = (async () => {
      const started = performance.now();
      this.log.info(
        "optimize.start",
        `Optimizing “${book.title}” for ${profile.name} (${profile.device_model})`,
        { bookId: book.id, detail: { profile: profile.name } },
      );
      const summary = await this.sidecar.call<OptimizeSummary>(
        "optimize",
        {
          inPath: source,
          outPath: target,
          deviceModel: profile.device_model,
          quality: profile.jpeg_quality,
          grayscale: !!profile.grayscale,
          autoCrop: !!profile.auto_crop,
          splitText: !!profile.split_text,
        },
        (e) => {
          if (e.message) {
            this.log.debug("optimize.step", `${e.tag}: ${e.message}`, { bookId: book.id });
            onProgress?.(String(e.tag ?? ""), String(e.message));
          }
        },
      );
      this.log.info(
        "optimize.done",
        `Optimized “${book.title}”: ${summary.images ?? 0} image(s), ` +
          `${summary.fixes ?? 0} fix(es), ${fmt(summary.orig_size)} → ${fmt(summary.new_size)} ` +
          `in ${((performance.now() - started) / 1000).toFixed(1)}s`,
        { bookId: book.id, detail: summary as Record<string, unknown> },
      );
      return target;
    })();

    this.#inflight.set(target, job);
    try {
      const path = await job;
      return { path, optimized: true };
    } finally {
      this.#inflight.delete(target);
    }
  }

  /**
   * Every optimized copy of a book on disk, one per profile it has been sent
   * under. These are the exact bytes a reader holds, so anything derived from
   * what we delivered — a document hash, a size — is derived from these.
   */
  async cachedCopies(bookId: string): Promise<string[]> {
    const dir = this.paths.bookDir(bookId);
    const out: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.startsWith("opt-")) out.push(`${dir}/${entry.name}`);
      }
    } catch { /* no such book dir */ }
    return out;
  }

  /** Drop cached optimized copies for a book (all profiles). */
  async clearCache(bookId: string) {
    try {
      for await (const entry of Deno.readDir(this.paths.bookDir(bookId))) {
        if (entry.name.startsWith("opt-")) {
          await Deno.remove(`${this.paths.bookDir(bookId)}/${entry.name}`).catch(() => {});
        }
      }
    } catch { /* no such book dir */ }
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

function fmt(n?: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]}`;
}
