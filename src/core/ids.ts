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
 * Deterministic on-device filename: `<bookId>__<title>.epub`.
 * Lets us re-match device contents from `/api/files` alone if the local
 * manifest is ever lost.
 */
export function deviceFilename(bookId: string, title: string): string {
  return `${bookId}__${sanitizeForFilename(title)}.epub`;
}

/** Recover a book id from a device filename produced by `deviceFilename`. */
export function bookIdFromDeviceFilename(name: string): string | null {
  const m = /^([0-9a-z]{16})__.*\.epub$/i.exec(name);
  return m ? m[1] : null;
}
