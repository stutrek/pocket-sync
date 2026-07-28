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

/** Strip characters the device firmware (FAT-ish naming) copes badly with. */
export function sanitizeForFilename(s: string, max = 60): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return (cleaned || "book").slice(0, max).replace(/[._]+$/, "");
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

/**
 * Names for a whole set at once, so a collision can be broken deterministically
 * rather than depending on the order books happen to sync in.
 */
export function deviceFilenames(
  books: { id: string; title: string; author?: string }[],
): Map<string, string> {
  const byName = new Map<string, { id: string; title: string; author?: string }[]>();
  for (const book of books) {
    const name = deviceFilename(book.title, book.author);
    const bucket = byName.get(name);
    if (bucket) bucket.push(book);
    else byName.set(name, [book]);
  }

  const out = new Map<string, string>();
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      out.set(bucket[0].id, name);
      continue;
    }
    // Same title and author: fall back to a slice of the content hash, which is
    // stable across runs and different for genuinely different files.
    for (const book of bucket) {
      out.set(book.id, name.replace(/\.epub$/, `_${book.id.slice(0, 6)}.epub`));
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
