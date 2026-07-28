/**
 * Existing e-reader libraries already on this machine.
 *
 * People's books are usually in Calibre or Adobe Digital Editions before Pocket
 * Sync ever runs, and telling them to copy it all into a new folder is a bad
 * answer — a book added to Calibre should just appear. So these are watched *in
 * place*, as ordinary libraries that happen to live outside the library root.
 *
 * That is the single exception to the containment rule in `src/core/roots.ts`,
 * and it is safe only because of two things this module enforces:
 *
 * 1. **The list of locations is fixed and lives here.** Callers choose a source
 *    by `id`; no request body ever supplies a path. `sourcePath()` is the only
 *    way an external library's path is produced.
 * 2. **Every source is read-only.** Enforced at the write and delete endpoints
 *    (`writable()` in `src/web/server.ts`), not here — but it is why watching
 *    outside the root is acceptable at all.
 *
 * The per-source `accepts()` filters are not cosmetic: a plain recursive walk of
 * a Calibre library indexes its `.original_epub` conversion backups as if they
 * were separate books.
 *
 * Kindle for Mac is deliberately not here. Its current DRM cannot be removed by
 * any available tool (docs/DESIGN.md), and anyone whose Kindle books are usable
 * has already moved them into Calibre — which this does support.
 */

import { ACCEPTED_EXTS, extOf } from "./ingest.ts";

export type SourceId = "calibre" | "ade" | "apple-books" | "kobo";

export interface KnownSource {
  id: SourceId;
  /** Shown in the UI. */
  label: string;
  /** One line on what this is and what to expect from it. */
  note: string;
  /** Candidate locations, most likely first. Probed in order. */
  candidates: string[];
  /**
   * Is this path, relative to the source root, one of its books?
   *
   * Pure and total so it can be tested without the application installed.
   */
  accepts: (relPath: string) => boolean;
  /** Books here are protected and need a key configured before they import. */
  expectDrm: boolean;
}

const home = () => Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";

/** Split a source-relative path into its segments, ignoring empty ones. */
function segments(relPath: string): string[] {
  return relPath.replace(/\\/g, "/").split("/").filter(Boolean);
}

/**
 * Calibre keeps `Author/Title (id)/Title - Author.epub` plus files that are not
 * books: `metadata.opf`, `cover.jpg`, and `.original_epub` — the pre-conversion
 * backup Calibre keeps when it converts in place. A `.zip` here is usually a
 * bundle Calibre made, not a comic.
 *
 * Deliberately *not* driven by `metadata.db`: on a real library that index
 * proved stale, listing an EPUB format for a book whose only file on disk is a
 * `.zip`. The filesystem is the source of truth here as everywhere else.
 */
export function calibreAccepts(relPath: string): boolean {
  const parts = segments(relPath);
  const name = parts[parts.length - 1] ?? "";
  if (!name || name.startsWith(".")) return false;
  if (name.startsWith("metadata.") || name === "metadata_db_prefs_backup.json") return false;
  if (/^cover\.(jpe?g|png)$/i.test(name)) return false;
  const ext = extOf(name);
  // `original_epub`, `original_mobi`, … are backups of the pre-conversion file.
  if (ext.startsWith("original_")) return false;
  if (ext === "zip" || ext === "opf" || ext === "json" || ext === "db") return false;
  return true;
}

/** Adobe Digital Editions: a flat folder of EPUBs and PDFs. */
export function adeAccepts(relPath: string): boolean {
  const name = segments(relPath).pop() ?? "";
  return ["epub", "pdf", "acsm"].includes(extOf(name));
}

/**
 * Apple Books. Purchases are FairPlay-protected and cannot be decrypted by
 * anything we drive, so only sideloaded files are worth offering. Apple also
 * stores some EPUBs as *directories*, which a file walk never yields — those
 * are silently out of scope rather than reported as failures.
 */
export function appleBooksAccepts(relPath: string): boolean {
  const name = segments(relPath).pop() ?? "";
  return ["epub", "pdf"].includes(extOf(name));
}

/** Kobo desktop keeps `.kepub` files, which need the Obok plugin, not DeDRM. */
export function koboAccepts(relPath: string): boolean {
  const name = segments(relPath).pop() ?? "";
  return ["kepub", "epub"].includes(extOf(name));
}

/**
 * Every location we are willing to watch. This list *is* the security boundary
 * for external libraries — nothing outside it can become one.
 */
export function knownSources(): KnownSource[] {
  const h = home();
  const all: KnownSource[] = [
    {
      id: "calibre",
      label: "Calibre library",
      note: "Usually already DRM-free, so these import with no setup.",
      candidates: [`${h}/Calibre Library`, `${h}/Documents/Calibre Library`],
      accepts: calibreAccepts,
      expectDrm: false,
    },
    {
      id: "ade",
      label: "Adobe Digital Editions",
      note: "Protected. DeDRM finds the key itself if Digital Editions is installed here.",
      candidates: [
        `${h}/Documents/Digital Editions`,
        `${h}/Library/Application Support/Adobe/Digital Editions`,
      ],
      accepts: adeAccepts,
      expectDrm: true,
    },
    {
      id: "apple-books",
      label: "Apple Books",
      note: "Only books you added yourself. Store purchases use FairPlay and cannot be opened.",
      candidates: [
        `${h}/Library/Containers/com.apple.BKAgentService/Data/Documents/iBooks/Books`,
      ],
      accepts: appleBooksAccepts,
      expectDrm: false,
    },
    {
      id: "kobo",
      label: "Kobo desktop",
      note: "Protected. Kobo books need Calibre's Obok plugin rather than DeDRM.",
      candidates: [`${h}/Library/Application Support/Kobo/Kobo Desktop Edition/kepub`],
      accepts: koboAccepts,
      expectDrm: true,
    },
  ];

  // Only offer what makes sense for this OS, so the list stays short and true.
  const os = Deno.build.os;
  return all.filter((s) => {
    if (s.id === "apple-books") return os === "darwin";
    return true;
  });
}

export function sourceById(id: string): KnownSource | undefined {
  return knownSources().find((s) => s.id === id);
}

/**
 * The on-disk location of a source, or null if it is not installed.
 *
 * This is the *only* way an external library's path is produced — it never
 * comes from a request.
 *
 * Where an application has moved its library between versions, several
 * candidates can exist at once — an application that moved its library between
 * versions may leave the old folder in place with books still in it. So the
 * candidate that actually holds books wins, and mere existence only breaks ties:
 * otherwise a freshly installed, still-empty location would hide the one with
 * the whole library in it.
 */
export async function sourcePath(source: KnownSource): Promise<string | null> {
  let best: { path: string; books: number } | null = null;
  for (const candidate of source.candidates) {
    try {
      if (!(await Deno.stat(candidate)).isDirectory) continue;
    } catch {
      continue; // Not installed.
    }
    // Counting is capped: we only need "has books", not how many.
    const { files } = await enumerate(source, candidate, 1);
    if (!best || files.length > best.books) {
      best = { path: candidate, books: files.length };
    }
  }
  return best?.path ?? null;
}

/**
 * Every book file in a source, as absolute paths.
 *
 * Applies `ACCEPTED_EXTS` as well as the source's own filter, because the
 * scanner does — a preview that counts files the scanner will then skip is a
 * preview that lies. (`metadata.db` in a Calibre library is exactly that case.)
 *
 * `limit` caps the walk so probing a huge library for a count stays cheap; the
 * caller is told whether it was truncated.
 */
export async function enumerate(
  source: KnownSource,
  root: string,
  limit = Infinity,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (dir: string, rel: string) => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return; // Unreadable subtree; the rest of the source is still usable.
    }
    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, childRel);
      } else if (
        entry.isFile &&
        ACCEPTED_EXTS.includes(extOf(entry.name)) &&
        source.accepts(childRel)
      ) {
        files.push(`${dir}/${entry.name}`);
      }
    }
  };

  await walk(root, "");
  return { files, truncated };
}
