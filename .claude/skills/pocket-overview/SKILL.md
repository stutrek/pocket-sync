---
name: pocket-overview
description: Start here for any work on this repo (Pocket Sync — a book-sync daemon for Xteink X3/X4 e-readers). Explains the architecture, where each concern lives, and the invariants that are easy to break. Use before making changes, when deciding which file to touch, or when a change spans more than one module.
---

# Pocket Sync — orientation

A self-hosted daemon that keeps a book library and pushes books (resampled for the device's ~380 KB
of layout RAM) to Xteink X3/X4 readers running CrossInk/CrossPoint firmware over Wi-Fi. One Deno
Desktop app is _both_ the daemon and the menu-bar UI.

It is not a Calibre clone. Two engines are reused rather than reimplemented: `ebook-convert` (format
conversion) and the CrossPoint plugin's Python optimizer (device-correct EPUB/image resampling).

## Where things live

| Path           | Concern                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`  | Entrypoint. Two HTTP listeners, then deferred tray/window startup                                                         |
| `src/app.ts`   | Object graph + dependency probing. No GUI imports — headless-safe                                                         |
| `src/core/`    | `config.ts`, `db.ts` (schema + migrations), `hash.ts`, `log.ts`, `events.ts`, `ids.ts`, `paths.ts`, `net.ts`              |
| `src/library/` | `scanner.ts` (watched folders), `ingest.ts`, `drm.ts`, `calibre.ts`, `imports.ts`, `books.ts`                             |
| `src/device/`  | `client.ts` (device HTTP API), `manager.ts` (discovery, registry, identity)                                               |
| `src/sync/`    | `profiles.ts` (resample cache), `engine.ts` (reconciliation), `reading.ts`, `kosync.ts`                                   |
| `src/engine/`  | `sidecar.ts` (supervises Python), `runtime.ts` (bundled CPython), `assets.ts` (embedded engine files)                     |
| `src/web/`     | `server.ts` (REST + SSE), `opds.ts` (catalog + its listener), `ui/` (Preact sources), `static/` (HTML shell + bundled JS) |
| `src/desktop/` | `shell.ts` (tray + window), `autostart.ts` (start at login)                                                               |
| `engine/`      | `sidecar.py` (ours) + `vendor/crosspoint_reader/` (upstream, unmodified)                                                  |
| `tests/`       | `unit_test.ts`, `fake_device.ts`, `acceptance.sh`                                                                         |

Related skills: `pocket-run` (running/debugging), `pocket-test` (verifying changes),
`pocket-device-protocol` (device + vendored engine), `pocket-package` (distributables).

## Data flow

```
watched folder → scan (md5 keyed on path/size/mtime) → detect DRM → [calibredb add]
       → ebook-meta → convert to book.epub → SQLite index row
device connects (UDP discovery or manual host) → /api/status → identity + model
       → POST /api/settings points its KOReader Sync client at the holder's sync server
       → /api/files walked → desired set = the bound folder → diff both ways
       → per book: optimize (cached) → stamp source md5 → WebSocket upload ≤2048 B frames
       → device_content manifest updated → events to UI/tray
reader taps "Sync Progress" → kosync listener → document hash → book → reading_state
```

## Invariants — breaking these causes real bugs

1. **No GUI imports outside `src/desktop/`.** `src/app.ts` and everything under
   `core/library/device/sync/web` must run headless (`deno task start`). `src/main.ts` reaches the
   shell through a dynamic import only.
2. **Optimization is per-device-profile and lazy**, never at ingest. Cached at
   `library/<md5>/opt-<hash>.epub`. The hash covers every setting that changes output _plus_ the
   engine version (`profileHash()` in `src/sync/profiles.ts`) — if you add a profile field that
   alters output, add it to that hash.

3. **The filesystem is the source of truth.** A watched folder _is_ a library; SQLite is a
   rebuildable index. Never write to a user's watched folder — the app only reads it. Library and
   user definitions live in `config.json`, not the database, so they survive a reset.
4. **Nothing may be watched outside the library root.** The user picks one top-level folder via the
   OS chooser; folders are addressed root-relative and validated by `resolveUnderRoot()` against the
   symlink-resolved path. Indexed files are readable and deletable through the API, so an absolute
   path parameter would be an arbitrary-file endpoint. Choosing the root and opening the dialog are
   loopback-only (`RequestCtx.local`), and the browser UI has no path text input at all — it browses
   with `/api/root/browse`. Don't add one. Compare and slice paths only against the **resolved**
   root that `resolveUnderRoot()` hands back: on a case-insensitive filesystem the configured string
   can differ from the on-disk spelling in case alone, and comparing against the wrong one makes a
   folder look like it escapes its own root.

   **The one exception — external sources.** An existing Calibre / Kindle / ADE library is watched
   in place, outside the root (`LibraryConfig.external`), because copying it would be the wrong
   answer. The rule therefore splits in two, and both halves must hold: (a) no _client-supplied_
   path may resolve outside the root — external libraries are created only by
   `POST /api/sources/:id/enable`, whose path comes from the fixed allowlist in
   `src/library/sources.ts`, never from a body; and (b) external libraries are **read-only**, which
   `writable()` in `src/web/server.ts` enforces on `DELETE /api/books/:id` and the upload route. If
   you add another writer, route it through `writable()` too. Per-source `accepts()` filters are
   also load-bearing, not cosmetic: without Calibre's, its `.original_epub` conversion backups index
   as separate books. Kindle is deliberately not a source — its current DRM cannot be removed by any
   available tool (docs/DESIGN.md); don't re-add it.
5. **Folders and devices are many-to-many, and reading state keys on the _user_.** A device's
   desired set is the union of its folders (`idsForLibraries`), and one unavailable folder aborts
   the whole sync. A "user" is a name in config with no login; `device_settings.user_id` says who is
   holding a reader, and `reading_state` / `kosync_user` are keyed by that — never by folder, and
   never by the device name the firmware reports. It follows that a reader nobody is holding is
   never configured for page sync (`configureReader()`): the only credentials it could be given
   would be somebody else's, and every report it made would land on their shelf.

   **Sync servers hang off the user too.** Each person has a list (`UserConfig.syncServers`) with
   one default; a reader reports to `device_settings.sync_server_id` if pinned, else to its holder's
   default — which is what makes handing a reader over re-point it. Ours is _synthetic_
   (`LOCAL_SYNC_SERVER_ID`, always first, resolved live by `KosyncServer.servers()`), never stored:
   its URL is this machine's LAN address and its credentials are generated, so a frozen copy in
   `config.json` would rot silently. A reader found pointing at a server that is **not already on
   the holder's list** is _adopted_ — copied into that list, pinned, and left alone. "Not already on
   the list" is the test, not "we never configured this reader": get that wrong and adoption repeats
   forever, and no pin change ever reaches the device. Anything that changes what a reader was told
   (holder, pin, default, our port) must clear `kosync_hash`, or the fingerprint short-circuit
   suppresses the push.
6. **Resampling defaults to the device's model** (`defaultProfileFor()`), backfilled at startup.
   "None" must stay a deliberate choice: unoptimized books are the likeliest way to crash the
   firmware.
7. **Book identity is the MD5 of the source file** and nothing else, cached against
   `(path, size, mtime)` in `file_index`. Derived artifacts are keyed by it, so two folders holding
   the same file share one optimized copy and a rename is a no-op.
8. **Device identity is never the IP.** It comes from a stable `/api/status` field; the
   address-bound fallback is a last resort and is surfaced in the UI.
9. **Device filenames are human readable** (`Title - Author.epub`, via `deviceFilenames()`, which
   breaks collisions deterministically). Identity travels in the EPUB's OPF as
   `pocketsync-source-md5`, stamped by the sidecar's `stamp` command — not in the filename.
   `legacyBookIdFromFilename()` exists only so files from the old scheme stay attributable.

   **Every route that hands book bytes to a device goes through `SyncEngine.prepareForDevice()`** —
   resample for the profile, stamp the OPF, record both document hashes. The upload loop and the
   OPDS catalog (`src/web/opds.ts`) both call it, and a third delivery path must too: skipping the
   stamp makes the file unattributable, and skipping the hash mapping makes every page-sync report
   about it land nowhere.
10. **One sync per device at a time.** A trigger during a run queues exactly one rerun
    (`#running`/`#rerun` in `src/sync/engine.ts`). Sync is async — the POST can return before work
    finishes.
11. **Deletion is guarded three ways.** Only files Pocket Sync placed are ever removed; an
    unreadable or missing folder aborts the sync instead of reading as "zero books"; and more than
    `REMOVAL_CONFIRM_THRESHOLD` (5) removals needs `confirmRemovals`. Relatedly, a scan already in
    progress returns the real result to every caller — never a zero-filled placeholder, which the
    engine would read as "delete everything".
12. **Schedulers fix their interval at `start()`.** `DeviceManager` and `Scanner` both capture the
    cadence when armed, so a settings change touching `discovery` or `scan` must call `restart()` —
    otherwise `discoveryStatus()` reports a cadence the app is not keeping. Discovery sweeps
    continuously and always has; `enabled: false` only turns off UDP broadcast, leaving the sweep
    probing manual hosts alone, which looks identical to "no reader on the network". The Devices
    view says which it is. The kosync listener is the same shape of problem solved differently:
    `KosyncServer.applyConfig()` rebinds it live from `config.kosync`, so its switch and port need
    no restart — call it from anywhere that writes them. `OpdsServer.applyConfig()` is the same
    contract for `config.opds`.
13. **The index self-heals at startup.** `Scanner.reconcile()` removes rows for unconfigured
    folders, stale `running` jobs, unreferenced books and orphaned artifact directories. Anything
    new that keys off `library_id` or writes under `library/<md5>/` should be swept there too, or it
    leaks silently.
14. **Long-running work must be cancellable.** Importing or syncing a big folder takes minutes and
    the user can remove the folder meanwhile. `Scanner.forget()` is called before the rows are
    deleted, the scan loop bails between files and purges what it added, and the sync loop re-checks
    the device's binding each book. Adding a new long loop over a library means adding the same
    check.
15. **Never edit `engine/vendor/`.** See `pocket-device-protocol`.
16. **Chunk size is capped at 2048 bytes** by the firmware. The config allows less, never more.

## Testing expectations

Any change touching the scanner, ingest, optimization, the device client or the sync engine should
keep `deno task acceptance` green (51 checks) — it runs against a simulated reader and unpacks the
delivered EPUBs to check they are genuinely device-safe. It binds port 8899 and aborts if that is
taken, so it can never drive a running `deno task dev` against your real library. See `pocket-test`.

## Design

`docs/DESIGN.md` is the model and the reasoning behind it. Read it before changing ingest, identity,
the sync engine or the UI.

## Docs

`README.md` covers install and user-facing behaviour. The original project brief is the conversation
that created the repo; §-references in comments (e.g. "§8.2") point at that brief's numbered
sections, preserved in the code comments themselves.
