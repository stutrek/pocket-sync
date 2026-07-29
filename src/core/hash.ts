/**
 * Content hashing. A book's identity is the MD5 of its source file
 * (docs/DESIGN.md) — it survives renames and moves, and deduplicates copies,
 * which is what lets two people keep the same book in two folders for the cost
 * of one optimized artifact.
 *
 * MD5 is used for identity, never for security. It also happens to be what
 * KOReader/CrossPoint's sync protocol speaks, though those hashes are computed
 * over the *delivered* bytes and must not be confused with these.
 */
import { createHash } from "node:crypto";

/** Stream a file through MD5 so multi-hundred-MB books don't land in memory. */
export async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  const file = await Deno.open(path, { read: true });
  // `file.readable` closes the handle when the stream ends or errors.
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

export function md5Bytes(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

/**
 * KOReader's "partial MD5" document id: 1 KiB sampled at exponentially spaced
 * offsets rather than the whole file, so a reader can identify a large book
 * without hashing it end to end.
 *
 * We compute it over the bytes we *deliver* and record it alongside the plain
 * MD5 of the same bytes, because which of the two CrossPoint reports is not
 * documented — storing both means the mapping resolves either way.
 *
 * **The offsets are not `1024 * 4^i`.** KOReader's `util.partialMD5` seeks to
 * `bit.lshift(1024, 2*i)` for `i` in −1..10, and LuaJIT takes a shift count
 * modulo 32: `i = -1` shifts left by 30, which overflows 32 bits and wraps to
 * **0**, not 256. That first sample is the head of the file. Compute it the
 * arithmetic way and every digest differs from the reader's, so every progress
 * report maps to no book at all — which is silent, because an unmatched report
 * is still a valid one.
 */
export const KOREADER_MD5_OFFSETS: readonly number[] = [
  0, // i = -1, wrapped
  ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i), // i = 0..10
];

export async function koreaderPartialMd5(path: string): Promise<string> {
  const SIZE = 1024;
  const hash = createHash("md5");
  const file = await Deno.open(path, { read: true });
  try {
    for (const offset of KOREADER_MD5_OFFSETS) {
      await file.seek(offset, Deno.SeekMode.Start);
      const buf = new Uint8Array(SIZE);
      // Lua's `file:read(1024)` returns a short block only at EOF, so a short
      // read here has to be filled rather than hashed as-is — otherwise the
      // digest depends on how the OS happened to split the read.
      let filled = 0;
      while (filled < SIZE) {
        const read = await file.read(buf.subarray(filled));
        if (read === null || read === 0) break;
        filled += read;
      }
      if (filled === 0) break; // seeked past EOF: KOReader stops here too
      hash.update(buf.subarray(0, filled));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}
