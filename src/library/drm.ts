/**
 * DRM detection, done by us rather than by Calibre.
 *
 * `ebook-convert` simply fails on a protected file, and DeDRM only runs on
 * `calibredb add` (docs/DESIGN.md). Detecting it ourselves means the Inbox can
 * say "DRM-protected Kindle book" accurately even on a machine with no Calibre
 * installed, instead of surfacing a conversion error nobody can act on.
 */

export type DrmKind = "adobe" | "kindle" | "pdf" | "kfx" | null;

export interface DrmCheck {
  drm: DrmKind;
  /** Human-readable reason, shown in the Inbox. */
  detail?: string;
}

const decoder = new TextDecoder("latin1");

/** Read at most `len` bytes starting at `offset` (from the end if negative). */
async function readChunk(path: string, offset: number, len: number): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const size = (await file.stat()).size;
    const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
    await file.seek(start, Deno.SeekMode.Start);
    const buf = new Uint8Array(Math.min(len, Math.max(0, size - start)));
    let read = 0;
    while (read < buf.length) {
      const n = await file.read(buf.subarray(read));
      if (n === null) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    file.close();
  }
}

export async function detectDrm(path: string, ext: string): Promise<DrmCheck> {
  try {
    switch (ext.toLowerCase()) {
      case "epub":
        return await epubDrm(path);
      case "mobi":
      case "azw":
      case "azw3":
      case "azw8":
      case "kfx":
      case "prc":
        return await kindleDrm(path);
      case "pdf":
        return await pdfDrm(path);
      case "kfx-zip":
        return { drm: "kindle", detail: "Kindle KFX" };
      case "acsm":
        return {
          drm: "adobe",
          detail: "Adobe loan file — this is a download token, not a book",
        };
      default:
        return { drm: null };
    }
  } catch {
    // Detection is advisory; a read failure shouldn't block an import.
    return { drm: null };
  }
}

/**
 * An encrypted EPUB carries `META-INF/encryption.xml`. Entry names are stored
 * as plain bytes in the zip, so scanning the central directory at the tail
 * finds it without unpacking the archive.
 */
async function epubDrm(path: string): Promise<DrmCheck> {
  const tail = decoder.decode(await readChunk(path, -70_000, 70_000));
  const head = decoder.decode(await readChunk(path, 0, 8_000));
  const haystack = head + tail;
  if (!haystack.includes("META-INF/encryption.xml")) return { drm: null };
  // Font obfuscation also uses encryption.xml, and those books open fine.
  const adept = haystack.includes("META-INF/rights.xml") ||
    haystack.includes("adept") ||
    haystack.includes("EncryptedKey");
  return adept ? { drm: "adobe", detail: "Adobe DRM (EPUB)" } : { drm: null };
}

/** `\xeaDRMION\xee` — a KFX-era encrypted payload with no voucher inside it. */
const DRMION = [0xea, 0x44, 0x52, 0x4d, 0x49, 0x4f, 0x4e, 0xee];

/**
 * Anything from the Kindle family, decided by **content rather than extension**.
 *
 * The extension lies: Kindle for Mac stores modern KFX books as `<ASIN>.azw`
 * whose actual contents are a DRMION payload, not a Palm database. Parsing that
 * as PalmDOC reads a nonsense record offset, finds nothing, and reports the
 * book as unprotected — after which it goes to `ebook-convert`, which fails
 * with an error nobody can act on. Observed on a real Kindle library, which is
 * why this sniffs the magic first.
 */
async function kindleDrm(path: string): Promise<DrmCheck> {
  const head = await readChunk(path, 0, 100);
  if (head.length >= DRMION.length && DRMION.every((b, i) => head[i] === b)) {
    return {
      drm: "kfx",
      detail: "Kindle KFX — the DRM voucher is not inside this file",
    };
  }

  // Palm database header: record 0 holds the PalmDOC header, whose encryption
  // type lives at offset 12. 0 = none, 1 = legacy, 2 = Mobipocket.
  if (head.length < 80) return { drm: null };
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  // Record 0's offset is stored at 78 in the Palm database header.
  const rec0 = view.getUint32(78, false);
  const rec = await readChunk(path, rec0, 16);
  if (rec.length < 14) return { drm: null };
  const encryption = new DataView(rec.buffer, rec.byteOffset, rec.byteLength).getUint16(12, false);
  if (encryption === 0) return { drm: null };
  return {
    drm: "kindle",
    detail: encryption === 1 ? "Kindle DRM (legacy)" : "Kindle DRM",
  };
}

async function pdfDrm(path: string): Promise<DrmCheck> {
  const tail = decoder.decode(await readChunk(path, -8_000, 8_000));
  return /\/Encrypt\b/.test(tail) ? { drm: "pdf", detail: "Encrypted PDF" } : { drm: null };
}
