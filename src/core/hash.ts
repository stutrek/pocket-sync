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
 */
export async function koreaderPartialMd5(path: string): Promise<string> {
  const STEP = 1024;
  const SIZE = 1024;
  const hash = createHash("md5");
  const file = await Deno.open(path, { read: true });
  try {
    for (let i = -1; i <= 10; i++) {
      const offset = STEP * Math.pow(4, i);
      if (!Number.isSafeInteger(offset)) break;
      await file.seek(offset, Deno.SeekMode.Start);
      const buf = new Uint8Array(SIZE);
      const read = await file.read(buf);
      if (read === null || read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}
