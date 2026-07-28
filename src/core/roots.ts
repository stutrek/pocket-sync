/**
 * The library root, and the rule that nothing may live outside it.
 *
 * Why this exists: a watched folder is indexed and its files become deletable
 * (`DELETE /api/books/:id` removes the source file) and readable (the converted
 * copy is downloadable). An API that accepts an arbitrary absolute path is
 * therefore an arbitrary-file-read-and-delete API, which is unacceptable at all,
 * and especially so when `webHost` is `0.0.0.0`.
 *
 * So the user picks one top-level folder once, and every watched folder is
 * addressed *relative to it*. The wire format cannot express a path outside the
 * root, and `resolveUnderRoot` re-checks after resolving symlinks in case
 * something inside the root points out of it.
 *
 * ## The one exception: external sources
 *
 * An existing Calibre library or Kindle content folder is never inside the
 * user's root, and copying it would be the wrong answer — people expect a book
 * bought in Calibre to appear here. So those *are* watched in place
 * (`LibraryConfig.external`), and the single rule above splits into two that
 * together preserve exactly the property that mattered:
 *
 * 1. **No client-supplied path may ever resolve outside the root.** Unchanged,
 *    and still enforced here by `resolveUnderRoot`. External libraries are
 *    created only by `POST /api/sources/:id/enable`, which looks the path up
 *    **server-side by source id** against the fixed allowlist in
 *    `src/library/sources.ts`. No request body can express an arbitrary path,
 *    and there is still no path text input anywhere in the browser UI.
 * 2. **External libraries are read-only.** Nothing writes into one and nothing
 *    deletes from one — `assertWritable` in `src/web/server.ts` is the single
 *    checkpoint, covering `DELETE /api/books/:id` and the upload route. This is
 *    what keeps the "arbitrary-file *delete* API" half of the risk closed.
 *
 * The read half is narrowed rather than closed: an external book's converted
 * copy is downloadable like any other. That is the point of indexing it, and it
 * is bounded by the allowlist — a caller cannot choose *what* becomes readable.
 */

/** Normalize to forward slashes with no trailing slash (except a bare "/"). */
export function normalizePath(p: string): string {
  const out = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  return out.length > 1 ? out.replace(/\/$/, "") : out;
}

/** Is `child` the same as, or inside, `parent`? Both must be normalized. */
export function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

export interface ResolveResult {
  path?: string;
  /**
   * The root as it exists on disk. Callers computing a relative path **must**
   * use this, not the configured root: on a case-insensitive filesystem the two
   * can differ in case alone (`Shared Book Folders` vs `…folders`), and a
   * case-sensitive comparison against the wrong one reports a child as being
   * outside its own root.
   */
  root?: string;
  error?: string;
}

/**
 * Resolve a root-relative path to a real directory inside the root.
 *
 * Rejects anything that escapes, including via `..` and via symlinks — the
 * containment check runs against the *resolved* path, not the requested one.
 */
export async function resolveUnderRoot(root: string, rel: string): Promise<ResolveResult> {
  if (!root) return { error: "no library root has been chosen yet" };

  let realRoot: string;
  try {
    realRoot = normalizePath(await Deno.realPath(root));
  } catch (err) {
    return { error: `library root is unreadable: ${err}` };
  }

  const cleaned = normalizePath(rel.trim());
  if (cleaned.startsWith("/")) return { error: "path must be relative to the library root" };
  // Cheap early rejection; the resolved check below is the one that counts.
  if (cleaned.split("/").includes("..")) return { error: "path may not contain “..”" };

  const candidate = cleaned === "" || cleaned === "." ? realRoot : `${realRoot}/${cleaned}`;
  let resolved: string;
  try {
    resolved = normalizePath(await Deno.realPath(candidate));
  } catch (err) {
    return { error: `folder not found: ${err}` };
  }

  if (!isInside(realRoot, resolved)) {
    return { error: "that folder is outside the library root" };
  }
  try {
    if (!(await Deno.stat(resolved)).isDirectory) return { error: "not a folder" };
  } catch (err) {
    return { error: `unreadable: ${err}` };
  }
  return { path: resolved, root: realRoot };
}

/**
 * The on-disk form of a path, or null if it cannot be read.
 *
 * Everything stored in config should go through this so the configured string
 * and the filesystem agree — including in case, which they otherwise need not on
 * macOS or Windows.
 */
export async function canonical(path: string): Promise<string | null> {
  try {
    return normalizePath(await Deno.realPath(path));
  } catch {
    return null;
  }
}

/** Express an absolute path as root-relative, for display. */
export function relativeToRoot(root: string, path: string): string {
  const r = normalizePath(root);
  const p = normalizePath(path);
  if (!isInside(r, p)) return p;
  return p === r ? "" : p.slice(r === "/" ? 1 : r.length + 1);
}

/**
 * The deepest folder containing all of these paths.
 *
 * Used once, to infer a root for installations configured before roots existed,
 * so an upgrade doesn't invalidate folders the user already had.
 */
export function commonAncestor(paths: string[]): string | null {
  const lists = paths.filter(Boolean).map((p) => normalizePath(p).split("/"));
  if (!lists.length) return null;
  const first = lists[0];
  let i = 0;
  while (i < first.length && lists.every((l) => l[i] === first[i])) i++;
  // A single folder yields itself; take its parent so siblings can be added too.
  if (lists.length === 1) i = Math.max(1, i - 1);
  const prefix = first.slice(0, i).join("/");
  return prefix.startsWith("/") && prefix.length > 1 ? prefix : null;
}
