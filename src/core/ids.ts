/** Sortable, collision-resistant ids and the deterministic device filename scheme (§9). */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford-ish, no i/l/o/u

function encode(n: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** ULID-ish: 8 chars of ms timestamp + 8 chars of randomness. Lexically sortable. */
export function newId(now = Date.now()): string {
  const rand = crypto.getRandomValues(new Uint8Array(5));
  let r = 0;
  for (const b of rand) r = r * 256 + b;
  return encode(now, 8) + encode(r, 8);
}

/** Short stable hash (FNV-1a, 32-bit) — used for resample profile cache keys. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Strip characters the device firmware (FAT-ish naming) copes badly with.
 *
 * Spaces are kept — this is a name a person reads off a reader's screen, and
 * `Piranesi - Susanna Clarke.epub` is what the shelf should say. They are safe
 * everywhere the name travels: the upload handshake is colon-delimited
 * (`START:<name>:<size>:<dir>`) and colons are among the characters dropped
 * here, device paths are URL-encoded on their way into `/api/files` and
 * `/download`, and `/delete` carries them inside a JSON array.
 */
export function sanitizeForFilename(s: string, max = 60): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._]+|[._\s]+$/g, "");
  return (cleaned || "book").slice(0, max).trim().replace(/[._]+$/, "");
}

/**
 * One folder name on the device. Same rules as a filename, but an empty result
 * is dropped by the caller rather than becoming "book": a folder that sanitizes
 * to nothing is better left out of the path than turned into a fake level.
 */
export function sanitizePathSegment(s: string, max = 60): string {
  const cleaned = sanitizeForFilename(s, max);
  return cleaned === "book" && !/[A-Za-z0-9]/.test(s) ? "" : cleaned;
}

/**
 * On-device filename. Human readable, because the reader keeps books
 * indefinitely and the user browses them there (docs/DESIGN.md). Identity comes
 * from the source MD5 stamped into the delivered EPUB's OPF, not from the name.
 */
export function deviceFilename(title: string, author?: string): string {
  const stem = author?.trim() ? `${title} - ${author}` : title;
  return `${sanitizeForFilename(stem, 80)}.epub`;
}

/** Where one book goes: folders below the upload path, then the file. */
export interface DevicePlacement {
  /** Sanitized folder names, relative to the upload path. May be empty. */
  dir: string[];
  filename: string;
}

/**
 * Place a whole set at once, so a collision is broken deterministically rather
 * than depending on the order books happen to sync in.
 *
 * `relDir` is the book's folder *as it sits on disk*, relative to its watched
 * folder — the device mirrors that structure, so what the user arranged is what
 * they browse on the reader. Names only have to be unique within their own
 * folder, which is why the buckets are keyed by the full path: two copies of a
 * book filed under different folders keep their real names.
 */
export function devicePlacements(
  books: { id: string; title: string; author?: string; relDir?: string[] }[],
): Map<string, DevicePlacement> {
  const byPath = new Map<string, { book: typeof books[number]; place: DevicePlacement }[]>();
  for (const book of books) {
    const dir = (book.relDir ?? []).map((s) => sanitizePathSegment(s)).filter(Boolean);
    const place = { dir, filename: deviceFilename(book.title, book.author) };
    const key = [...dir, place.filename].join("/").toLowerCase();
    const bucket = byPath.get(key);
    if (bucket) bucket.push({ book, place });
    else byPath.set(key, [{ book, place }]);
  }

  const out = new Map<string, DevicePlacement>();
  for (const bucket of byPath.values()) {
    if (bucket.length === 1) {
      out.set(bucket[0].book.id, bucket[0].place);
      continue;
    }
    // Same name in the same folder: fall back to a slice of the content hash,
    // which is stable across runs and different for genuinely different files.
    for (const { book, place } of bucket) {
      out.set(book.id, {
        dir: place.dir,
        filename: place.filename.replace(/\.epub$/, ` (${book.id.slice(0, 6)}).epub`),
      });
    }
  }
  return out;
}

/**
 * Recover a book id from the *legacy* `<bookId>__<title>.epub` scheme.
 *
 * Retained only so files placed by an older version stay attributable — they
 * are ours, so reconciliation is allowed to remove them. New deliveries use
 * `deviceFilename()`.
 */
export function legacyBookIdFromFilename(name: string): string | null {
  const m = /^([0-9a-z]{16})__.*\.epub$/i.exec(name);
  return m ? m[1] : null;
}
