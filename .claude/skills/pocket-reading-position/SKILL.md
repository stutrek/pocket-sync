---
name: pocket-reading-position
description: Where the reader keeps reading positions on its own SD card (.crosspoint/epub_<hash>/progress.bin), how to compute the cache-dir hash, decode and write the file, and what is safe to write back. Use when touching src/sync/reading.ts, src/sync/kosync.ts, the sync run's progress handling, or anything that wants a position without the user tapping "Sync Progress".
---

# Reading positions on the device

Page sync as shipped is **pull-only and user-initiated**: the reader is a KOReader Sync client, we
are its server (`src/sync/kosync.ts`), and it reports when somebody taps Sync in the reader menu or
uses the long-press action. There is no auto-sync on open or close — `launchKOReaderSync()` is
called from exactly those two places in the firmware.

The reader also keeps its position on its own SD card, and that file is readable **and writable**
over the HTTP API we already use. Everything below was verified against a real X3 on
`1.4.0-tiny`, and cross-checked against the firmware source
([crosspoint-reader/crosspoint-reader](https://github.com/crosspoint-reader/crosspoint-reader),
`develop`).

## The cache directory name is a hash of the device path

```
/.crosspoint/epub_<id>          <id> = FNV-1a 64 of the device path, in decimal
```

The firmware writes `"/.crosspoint/epub_" + std::to_string(std::hash<std::string>{}(path))`
(`src/activities/reader/EpubReaderActivity.cpp`), and on this toolchain `std::hash<std::string>` is
FNV-1a 64. The input is the **full device path with its leading slash** — not the basename, not
lowercased. Confirmed on six real books across two devices.

```ts
const FNV_OFFSET = 0xcbf29ce484222325n, FNV_PRIME = 0x100000001b3n, M = (1n << 64n) - 1n;
function cacheDirId(devicePath: string): string {
  let h = FNV_OFFSET;
  for (const b of new TextEncoder().encode(devicePath)) h = ((h ^ BigInt(b)) * FNV_PRIME) & M;
  return h.toString();
}
```

`.txt` books use `txt_<id>`, and a few legacy dirs carry 32-bit-looking ids — treat an id we cannot
reproduce as "no position", never as an error.

The consequence: **the dir follows the path, so a move or a rename orphans it.** Key any lookup off
the `device_content.device_path` we recorded, not off the md5 and not off a name we recompute.

## progress.bin — six bytes, three little-endian uint16

| Offset | Field                         |
| ------ | ----------------------------- |
| 0      | `currentSpineIndex`           |
| 2      | `nextPageNumber` — page within that spine item |
| 4      | `cachedChapterTotalPageCount` |

`EpubReaderActivity::onEnter` accepts a read of **4 or 6 bytes** (4 = pre-total-page-count files),
and treats `nextPageNumber == 0xFFFF` as an in-memory "open previous chapter at its last page"
sentinel that it discards — so never write it. A `progress.bin.bak` sits alongside; the firmware
writes through `ProgressFile::writeAtomic` (tmp file, then remove + rename, `ProgressFile.h`).

Example: `02 00 01 00 03 00` = spine 2, page 1, and that chapter is 3 pages long.

## Percentage is reproducible offline

`Epub::calculateProgress` (`lib/Epub/Epub.cpp`) is:

```
intra  = totalPages > 1 ? pageNumber / (totalPages - 1) : 0
pct    = (cumulativeSpineBytes(spine - 1) + intra * bytesOfSpine(spine)) / bookSize
```

over the spine items of **the EPUB we delivered**, which we still hold at
`library/<md5>/opt-<hash>.epub`. So progress.bin converts to the percentage the shelf shows without
asking the device anything.

## Reading and writing over the HTTP API

Verified on hardware — the hidden dir is exposed regardless of the `showHiddenFiles` setting:

```bash
curl -s 'http://<ip>/api/files?path=/.crosspoint'                        # lists epub_<id> dirs
curl -s 'http://<ip>/download?path=/.crosspoint/epub_<id>/progress.bin'  # the 6 bytes
curl -X PUT --data-binary @progress.bin 'http://<ip>/.crosspoint/epub_<id>/progress.bin'  # 201
curl -X POST -d 'paths=["/.crosspoint/<file>"]' 'http://<ip>/delete'
```

A read is ~6 bytes per book, so pulling every delivered book's position during a sync is cheap.

## What is safe to write back

**Reading is straightforwardly correct. Writing is only safe at chapter granularity.**

`nextPageNumber` and `cachedChapterTotalPageCount` are layout-dependent — font size, margins,
orientation all change them — so a page number from a different device (or from the same device
before a font change) lands in the wrong place. The firmware solves this in
`ProgressMapper::fromRichPosition`: it uses the locally cached page count, and falls back to a
paragraph LUT or an intra-spine fraction. We do not have that logic and should not reimplement it.

So a write is: **spine index, page 0**, unless the stored `totalPages` equals the
`cachedChapterTotalPageCount` we just read from that device's own progress.bin, in which case the
page transfers as-is. That is the same test the firmware makes.

Two more constraints:

- **Never write to the open book.** The reader loads progress.bin on open and rewrites it on
  exit/sleep, so a write to whatever `/.crosspoint/state.json` names in `openEpubPath` is either
  clobbered or ignored.
- **Attribute to the holder**, like every other position — `device_settings.user_id`, never the
  device name the firmware reports. See invariant 5 in `pocket-overview`.

## The better direction for writes: the rich position

The reader's own sync client sends a **rich position** to servers it recognises as crosspoint-sync —
`pctQ`, `spineIndex`, `pageNumber`, `totalPages`, `paragraphIndex`, `xpath`
(`lib/KOReaderSync/KOReaderSyncClient.h`). We already store the whole payload verbatim in
`reading_state.position_json` and echo `position` back on `GET /syncs/progress/{document}`, so when
the reader pulls, *it* does the remapping with the layout knowledge we lack. Preserving that payload
untouched is what makes CrossPoint↔CrossPoint sync lossless — don't reduce it to a percentage.

## Other on-device files worth knowing

Under `/.crosspoint/`:

| File                     | Contents                                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| `state.json`             | `openEpubPath`, pending bookmark fields, sleep-screen state              |
| `recent.json`            | recents: `path`, `title`, `author`, `coverBmpPath` — a free path→book map |
| `koreader.json`          | `username`, `password_obf`, `serverUrl`, `matchMethod` — what the reader was actually told |
| `settings.json` / `crossink-settings.json` | the flat settings the firmware persists                |
| `global_stats.bin`, `<book>/stats_v5.bin`  | reading-time stats (format not decoded)                |
| `<book>/book.bin`        | parsed metadata cache — `\xffCXB` magic, then title/author/cover href    |

`recent.json` is the cheapest way to check our path→hash derivation on a live device: every entry
carries both the path and the `epub_<id>` it maps to.

## Two settings `configureReader()` does not write

Both are real settings keys (`src/SettingsList.h`), so they go through the same
`POST /api/settings` partial-body write as the `ko*` block:

- `koSyncBehavior` — `0` = ask every time, `1` = **smart** (compares timestamps and acts without
  prompting). Smart makes the user's tap a single action with no dialog.
- `koSendMetadata` — whether the reader includes title/author with its report.

Neither removes the tap. Only the filesystem route above moves a position without one.
