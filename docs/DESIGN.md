# Pocket Sync — design

> **Status: agreed, not yet implemented.** This describes the target model. The code currently
> implements the older model shown under [What this reverses](#what-this-reverses). `README.md`
> documents present behaviour; the two will diverge until the roadmap below is complete.

## Why

The first version works end to end, but its model is a sync daemon's, not a reader's. Books arrive
only through an upload button; identity is a generated id; what syncs is configured through a
four-way `source × mode` rule; the on-device filename is machine-readable rather than
human-readable; and nothing in the app knows whether a book has been read.

The target is a sentence a person can hold in their head:

> **This folder is on my reader.**

Everything below follows from that, plus reading progress flowing back from the device.

## The model

1. **The filesystem is the source of truth.** A user-chosen folder _is_ a library. SQLite is a
   rebuildable index and a UI affordance — never authoritative.
2. **Identity is the MD5 of file contents.** Survives renames and moves; deduplicates copies.
3. **Folders and devices are many-to-many.** A device syncs any number of folders (its desired set
   is their union, deduplicated); a folder feeds any number of devices.
4. **A user is a name, not an account.** There is no login. Each device records which user is
   currently holding it, and that is switchable — reading progress and page-sync credentials key on
   the user, so one person reading a book that sits in two of their folders has one position, while
   two people with a copy of the same file stay independent.
5. **Everything in a folder goes to the devices bound to it.** No per-book membership, no lists.
6. **A file removed from the folder is removed from the device**, subject to the deletion rails.
7. **Resampling defaults to the device's model.** Sending an unoptimized book to a reader with ~380
   KB of layout RAM is the likeliest way to crash it, so "none" is a deliberate choice.
8. **Device filenames are human friendly** — `Piranesi - Susanna Clarke.epub` — because with an
   archive of hundreds of books the user browses them on the device.
9. **We never write to the user's folder.** Every derived artifact lives in the app's data dir.
10. **Sharing means copying the file.** Two people, two folders, two devices. Identical MD5 means
    one shared optimized artifact, so a copied book costs disk in their folder and no extra work
    here.

## What this reverses

| Current code                              | Target                                                |
| ----------------------------------------- | ----------------------------------------------------- |
| Upload button is the only way in          | Watched folder is primary; upload writes into it      |
| `bookId` = `newId()` (ULID-ish)           | `bookId` = MD5 of file contents                       |
| App owns `library/<id>/original.<ext>`    | App indexes the user's file in place                  |
| Device filename `<bookId>__<title>.epub`  | `Title - Author.epub`, source MD5 embedded in the OPF |
| `sync_rule.source_type` = library \| list | Removed — the bound folder is the source              |
| `mode` = `add_new` \| `mirror`            | Removed — always reconcile                            |
| Lists drive what syncs                    | Lists gone from sync entirely                         |
| Reading state unknown                     | kosync server; `finished` is an observed tag          |

Two ideas considered and deliberately dropped, recorded so they aren't revived by accident:

- **Per-device checkboxes at import time.** Moot once there is no membership model — a book's
  destination is decided by which folder it lands in.
- **The device as a write-only archive with one-shot delivery.** Attractive (the device has ample
  storage, and read books are worth keeping for reference), but incompatible with "the filesystem is
  the source of truth." Sync is reconciliation.

Also rejected: **rewriting the app in Python.** It would lose single-host cross-compilation to five
targets (`scripts/package.ts`), and DeDRM runs inside Calibre's own interpreter regardless of our
language, so it buys nothing for the one feature that motivated it. The Python we ship stays scoped
to the vendored optimizer.

## The library root

Everything watched lives under **one folder the user picks once**, through the OS's own chooser.
Watched folders are addressed _relative_ to it (`POST /api/libraries {relPath}`), so the wire format
cannot express a path outside it.

This is a security boundary, not a convenience. An indexed file is readable
(`GET
/api/books/:id/download` serves the converted copy) and deletable (`DELETE /api/books/:id`
removes the source), so an endpoint accepting an arbitrary absolute path would be an arbitrary-file
read and delete API — reachable from the LAN whenever `webHost` is `0.0.0.0`.

`src/core/roots.ts` enforces it:

- `resolveUnderRoot()` joins, resolves with `Deno.realPath`, and re-checks containment against the
  _resolved_ path — so `..`, absolute paths, and symlinks pointing out of the root are all refused.
- Containment is segment-aware, so `/books-private` is not "inside" `/books`.
- **Everything stored is canonicalised** (`canonical()`, applied to the root and to every library
  path at startup). macOS and Windows are case-insensitive but case-preserving, so a path spelled
  with the wrong case is accepted by the filesystem and then fails every comparison against a
  resolved path — a folder ends up looking like it is outside its own root. `resolveUnderRoot()`
  returns the resolved root for exactly this reason: relative paths must be computed against it, not
  against the configured string.
- Choosing or changing the root, and opening the native dialog, are restricted to callers on this
  machine (`RequestCtx.local` in `src/web/server.ts`).
- **The root may be watched as a folder in its own right** — `resolveUnderRoot(root, "")` resolves
  to the root, which is how "sync my whole library" is expressed. It is one `LibraryConfig` like any
  other, so it binds to readers the same way. Sub-folders of a watched root are then shown as
  _included_ rather than tickable: watching both would index every file twice and shelve it twice.
- There is **no path text input anywhere in the browser UI**. It navigates the root with
  `GET /api/root/browse?rel=` and ticks folders. Typing a path is not an available action.
- `commonAncestor()` gives installations predating roots a sensible one at first start, so an
  upgrade doesn't invalidate folders the user already had.

The native chooser (`src/core/folder_dialog.ts`) shells out — `osascript` on macOS,
`FolderBrowserDialog` on Windows, `zenity`/`kdialog` on Linux — because Deno Desktop exposes no
dialog API. It imports nothing GUI and returns `null` where no chooser exists, so it stays
headless-safe.

### Existing e-reader libraries — the one exception

Most people's books are already in Calibre or Adobe Digital Editions. Requiring them to copy that
into a new folder is the wrong answer: a book added to Calibre should simply appear. So those
libraries are watched **in place**, outside the root, as `LibraryConfig.external`
(`src/library/sources.ts`).

The containment rule's _purpose_ — that the API must not become an arbitrary-file read-and-delete
API — is preserved by splitting the one rule into two:

1. **No client-supplied path may resolve outside the root.** Unchanged. External libraries are
   created only by `POST /api/sources/:id/enable`, which resolves the path **server-side by source
   id** from a fixed allowlist. No request body can express a path; the browser UI still has no path
   input. `POST /api/libraries` builds its library field by field rather than spreading the body, so
   `external` cannot be injected there — keep it that way.
2. **External libraries are read-only.** `writable()` in `src/web/server.ts` is the single
   checkpoint, covering `DELETE /api/books/:id` (which calls `Deno.remove` on the real file) and the
   upload route. A book in both a normal folder and a source deletes only the copy we own, and says
   so. Un-watching a source removes rows and no files. Any new writer must route through
   `writable()`.

The read half is narrowed rather than closed — an external book's converted copy is downloadable
like any other, which is the point of indexing it — but bounded by the allowlist, so a caller cannot
choose _what_ becomes readable. All three source routes are loopback-only, so a LAN caller cannot
even enumerate what is installed.

Two findings from real libraries that the code encodes:

- **Per-source file filters are load-bearing.** Calibre keeps `.original_epub` conversion backups
  beside the real file, plus `metadata.opf`, `cover.jpg` and `metadata.db`; a naive walk indexes the
  backups as separate books. `enumerate()` applies `ACCEPTED_EXTS` as well, so a preview never
  counts files the scanner will then skip.
- **Calibre's `metadata.db` is not authoritative.** On a real library it listed an EPUB format for a
  book whose only file on disk was a `.zip`. The filesystem is the source of truth here as
  everywhere else, so enumeration walks the folder rather than reading that index.

### Kindle is deliberately out of scope

The current Kindle desktop app stores a book as a directory of encrypted parts, and its DRM cannot
be removed by any available tool. Verified end to end against a real library: packaging the
directory into the `.kfx-zip` DeDRM expects works, `calibredb add` accepts it, and DeDRM then fails
with "Unknown type encountered in envelope, expected VoucherEnvelope". Its last release predates the
format and the project has been dormant since 2024.

Support for it was built and then removed, along with the "a book may be a directory" model change
it required (per-source `isBookDir`, directory hashing, a sidecar zip command). The reasoning, so it
is not rebuilt on a hunch:

- **The books it reached cannot be used.** Everything downstream of the packaging step is blocked on
  a dependency nobody can supply.
- **Anyone whose Kindle books are usable has already put them in Calibre**, which is a first-class
  source. The Kindle path was a second way to reach the same shelf, for the subset of people it
  could not actually help.
- It carried real weight for that: identity stopped being "the MD5 of a file", the scanner grew a
  second notion of what a book is, and ingest gained a packaging step before every import.

What survives is deliberate: `.kfx`/`.azw8`/`.kfx-zip` stay in `ACCEPTED_EXTS` so a stray file is
_explained_ rather than silently skipped, and `detectDrm` sniffs the DRMION magic rather than
trusting the extension — a KFX payload named `.azw` otherwise parses as an unencrypted Palm database
and reads as a healthy book right up until conversion fails.

Serial entry stays, and its scope is narrow on purpose: a Kindle _serial_ only unlocks books
transferred to that specific e-ink device. Books a desktop app downloaded are encrypted to the app
install instead, and DeDRM finds that key itself — so we neither read nor write it. Extracting it
ourselves was built and then removed with the rest of the Kindle work: it reached into the old app's
`.kinf2018` through DeDRM's own scripts, which is a lot of machinery aimed at an application this no
longer supports.

We still _report_ how many Kindle-app and Adobe keys DeDRM holds, because "none of your keys open
this book" and "no key is configured at all" are different answers and the count is what tells them
apart.

## Architecture

### Libraries and the scanner

Library definitions live in `config.json`, not SQLite, so they survive a lost database and stay
user-editable:

```jsonc
libraries: [
  { id: "stu",   name: "Stu's books",   path: "/Users/stuart/Books", deviceIds: ["x4a1"] },
  { id: "sarah", name: "Sarah's books", path: "/Users/sarah/Books",  deviceIds: ["x3b2"] }
]
```

New `src/library/scanner.ts`:

- Initial recursive walk, then `Deno.watchFs`, plus a **periodic rescan backstop**. Filesystem
  events are unreliable on Dropbox/iCloud/Syncthing folders, which is exactly where book collections
  live.
- **Settle check** before importing — wait for `size` and `mtime` to stop changing — so a
  half-written download is never ingested. Ignore `.part`, `.crdownload`, `.DS_Store`, dotfiles.
- Accepted extensions come from `ACCEPTED_EXTS` in `src/library/ingest.ts`.
- **One book in several formats is one book.** `Dune.epub` and `Dune.mobi` hash differently, so
  content identity cannot catch them and the reader would show the title twice. `groupEditions()`
  gathers them by `editionKey()` — the filename, normalized, ignoring the directory, because every
  layout that produces these pairs repeats the name (Calibre's per-book folder, a download folder, a
  library split into `epub/` and `mobi/` trees) — and only the best format is imported, so the MOBI
  is never hashed or converted at all. Files of the _same_ format are two editions rather than two
  formats and both stand; a format that will not import (a DRM'd EPUB beside a plain MOBI) falls
  through to the next best rather than costing the book.
- **Hash cache**: MD5 keyed on `(path, size, mtime)` in a new `file_index` table, so a rescan only
  rehashes changed files. This is what makes content-addressed identity affordable.
- Changes are published on the existing `EventBus` (`src/core/events.ts`).

`src/core/paths.ts` keeps its derived-artifact layout, keyed by MD5 instead of `newId()`.
`original(bookId, ext)` is retired — we no longer copy the source.

### Ingest as a staged pipeline

`addFile()` in `src/library/ingest.ts` currently shells straight to `ebook-convert`, which **fails
on DRM'd input**: DeDRM is a Calibre `FileTypePlugin` that only fires on `calibredb add`.

```
file → md5 → detect DRM → [calibredb add → scratch library] → EPUB → metadata + cover → ready
                            ↑ only when DRM is detected and the plugin is present
```

- **DRM detection is ours, not Calibre's** — `META-INF/encryption.xml` in an EPUB, format markers in
  Kindle files — so we can report "DRM-protected Kindle book" accurately even with no Calibre
  installed.
- **Keys are inherited if present, appended on request, never owned.** `calibredb` runs against the
  user's existing Calibre config directory, so anyone who already configured DeDRM in the Calibre
  GUI needs nothing from us. What we add is the ability to _append_ a Kindle serial to DeDRM's own
  `plugins/dedrm.json` — the config directory comes from
  `calibre-debug -c "from calibre.constants import config_dir; print(config_dir)"`, the write is a
  read-modify-write that preserves every key we do not understand, and upstream's own CLI
  instructions document hand-writing that file. We store no key ourselves: not in `config.json`, not
  in the database. That is a security property as much as a design one, since `GET /api/settings` is
  not loopback-gated — the key endpoints are.
- **Plugin detection must be parsed, not grepped.** Calibre prints plugin _load failures_ on stdout
  before the `--list-plugins` table, so a machine carrying the superseded "Inept Epub DeDRM" plugins
  matches `/dedrm/i` and reads as fully configured when nothing can decrypt anything. Parse the
  table (`parsePluginList`, `src/library/dedrm.ts`) and require a `File type` row named exactly
  `DeDRM`. "Installed but disabled" is tracked separately: the fix is `--enable-plugin`, not a
  download. Offer one-click install via `--add`, fetched at runtime; the plugin is **not** bundled.
- **Say which failure it is.** "No key configured" and "none of your keys open this book" have
  different fixes — the second is usually a different account, and no amount of setup solves it.
  Decide between them from what is actually in the key store, not by pattern-matching DeDRM's
  output, which varies by format and version.
- **KFX is explained, not solved** — see
  [Kindle is deliberately out of scope](#kindle-is-deliberately-out-of-scope).
  `.kfx`/`.azw8`/`.kfx-zip` are accepted into the Inbox purely so it can say so, for the same reason
  `.acsm` is: silence is the worst possible answer.
- **Metadata**: keep `ebook-meta` (`src/library/calibre.ts`); add `fetch-ebook-metadata` for covers
  and missing metadata. Covers matter far more once the UI is a shelf rather than a table.
- Each stage persists to an `import_job` row, so a blocked import survives a window close.

### Sync as folder reconciliation

`idsForSource()` in `src/library/books.ts` and the entire `source_type`/`mode` branch in
`src/sync/engine.ts` go away.

```
desired = md5 set of the bound library
present = device manifest, reconciled against /api/files
send    = desired − present          remove = present − desired
```

- **Delivered filename** is `Title - Author.epub` via the existing `sanitizeForFilename()` in
  `src/core/ids.ts`, which already handles the firmware's FAT-ish charset, with a deterministic
  tiebreak on collision. Spaces are kept: this is a name read off a reader's screen, and it is safe
  everywhere the name travels — the upload handshake is colon-delimited and colons are among the
  characters dropped, device paths are URL-encoded into `/api/files` and `/download`, and `/delete`
  carries them inside a JSON array. `bookIdFromDeviceFilename()` is retired.
- **Delivered location mirrors the watched folder, under the folder's own name.** A book filed under
  `Sci-Fi/` in a folder called "Hunger Games Trilogy" is filed under `Hunger Games Trilogy/Sci-Fi/`
  on the reader, below the upload path (`devicePlacements()`, fed by `relativeDirSegments()`). The
  folder name is the top level because the upload path defaults to `/` and a reader commonly syncs
  several folders: without it they all merge, and a collection that happens to be flat on disk
  becomes indistinguishable from every other one. It is the folder's _label_, not its basename, so
  renaming a folder moves its books — the same cost as reorganizing the folder itself, which is the
  behaviour it should match. "This folder is on my reader" covers the arrangement, not just the
  contents, and nothing invents a hierarchy the user did not make. Depth is capped at
  `MIRROR_MAX_DEPTH`: the firmware creates one level per request, and a book below `listEpubs()`'s
  recursion limit would be invisible to us and re-sent on every sync. A name therefore only has to
  be unique within its folder.
- **Moving a book is send-then-delete**, because the firmware has no rename. Anything whose recorded
  `device_path` is not where it now belongs is re-sent and the old copy removed once the new one has
  landed. It is not a removal — the book stays on the reader — so it is counted as a send in
  `plan()` and kept clear of the removal-confirmation rail. Folders that a departing book emptied
  are pruned upwards towards the upload path, one folder at a time, and only the ones we emptied:
  the upload path defaults to `/`, where a general sweep for empty folders would delete the user's
  own.
- **Re-identification** moves from the filename into an embedded `<meta>` in the delivered EPUB's
  OPF carrying the source MD5. The optimizer already rewrites the file, so it costs nothing, and it
  survives the user renaming files on the device — which the filename scheme did not. Recovery is
  download-and-read-one-field instead of parsing a listing.
- **Startup reconciliation.** `Scanner.reconcile()` drops index rows for folders that are no longer
  configured, clears `running` import jobs left by a killed process, purges books no folder holds
  and no device carries, and sweeps derived-artifact directories with no book row. It runs on every
  start, and is reachable as `POST /api/libraries/reconcile`. This is not just bug insurance:
  `config.json` is hand-editable, so deleting a `libraries` entry there never passes through the
  API's cleanup path.
- **Cancellation.** Removing a folder calls `Scanner.forget()` _before_ deleting its rows, so an
  in-flight scan stops between files instead of re-inserting what the deletion removed; the scan
  purges anything it added after the cancellation landed. The upload loop re-checks the device's
  folder binding on every book, so a sync in progress stops rather than finishing a folder the user
  has taken away.
- **Deletion rails.** The failure mode to design against is an unmounted external drive or a
  mid-sync cloud folder scanning as empty and wiping a reader:
  - Never act when a library root is missing or unreadable. Skip the sync and say so loudly; an
    empty scan is never interpreted as "zero books." With several folders bound, one unavailable
    folder aborts the **whole** sync — its books would otherwise look deleted, and that is
    indistinguishable from the user removing them.
  - Removing more than **5** books pauses and asks for confirmation.
  - Only ever delete files Pocket Sync placed there. Side-loaded books survive.
- Unchanged: the `#running`/`#rerun` single-flight guard, and the per-profile optimize cache keyed
  by `profileHash()` in `src/sync/profiles.ts` — which covers `ENGINE_VERSION`, and must keep doing
  so.
- What survives of `sync_rule` is `profile_id`, `enabled`, `auto_on_connect`, plus the library
  binding. Renamed `device_settings`; it is no longer a rule.

### kosync server

CrossPoint firmware includes a KOReader Sync client (**Settings → System → KOReader Sync**) with a
configurable server URL, so the reader can report reading progress to us.

We implement the compatible subset against our own SQLite rather than vendoring
[crosspoint-sync](https://github.com/crosspoint-reader/crosspoint-sync), while conforming to its
documented contract. The reason is specific: the value to us is the hash↔book mapping, and a generic
kosync server cannot do it — the same book optimized for an X3 and an X4 is two different files with
two different hashes, and only we know they are one book.

- Endpoints: `POST /users/create`, `GET /users/auth`, `PUT /syncs/progress`,
  `GET /syncs/progress/{document}`. Auth headers `x-auth-user` and `x-auth-key` (lowercase 32-hex
  MD5 of the password).
- Store the whole payload including CrossPoint's `position` extensions (`pctQ`, `spine`, `page`,
  `para`, `anchor`) opaquely, so we don't discard data we don't yet use — and hand the reader's own
  `progress` locator back **verbatim** on the next request. A percentage with no locator puts the
  book at page one, which on the device is indistinguishable from never having synced.
- **Two different hashes — do not conflate them.** `bookId` is the MD5 of the _source_ file; the
  kosync `document` is a hash of the _delivered_ bytes. Record `document → bookId` at delivery time,
  when both are in hand. Being the server means the exact hash method can be confirmed empirically
  from the first real request rather than guessed.
  - Binary matching is KOReader's `util.partialMD5`, whose offsets are `1024 << 2i` **in 32 bits**
    for `i` in −1..10 — the first wraps to 0, not 256 (see the `pocket-device-protocol` skill). Get
    it wrong and every report maps to nothing while every request still succeeds, which is why
    `tests/acceptance.sh` walks the reader's full round trip rather than trusting the mapping.
  - Mappings are written only when a book is **sent**, so a change to the hashing strands every book
    already on a reader. `DOCUMENT_HASH_VERSION` and `remapDeliveredDocuments()` re-derive them once
    at the next start.
- **A document we cannot map is still a position worth keeping.** A reader holds side-loaded books
  too, whose hash matches nothing of ours and never can. Their positions are stored against the hash
  alone (`unmapped_progress`, keyed by user like everything else here) and served back. Mapping to a
  book is the value we add, not a precondition for being a correct sync server — and dropping the
  report is indistinguishable, from the device, from page sync being broken: the reader is answered
  either way, then reads back nothing and opens at page one. These rows deliberately stay out of
  `reading_state`, which is joined into the library and swept against known books.
- **Attribution is by credential, not by device name.** Each _user_ gets their own kosync username
  and password (`kosync_user.user_id`). Two people holding the same file produce the same document
  hash, so a report is written against the user who authenticated and nobody else. The reported
  device id is stored for display only.
- **`finished` is a tag** keyed by `(user_id, book_id)`, auto-set at `percentage >= 0.99` and
  manually overridable.
- **Setup is zero-configuration: we write it to the reader.** The server is on by default, its LAN
  address is resolved for the user (`lanAddress()` in `src/core/net.ts`), credentials are generated
  on demand, and `configureReader()` in `src/sync/engine.ts` posts the lot to the firmware's
  `/api/settings` at the top of every sync — the same JSON block the reader's own web UI sends:
  `{koUsername, koPassword, koServerUrl, koMatchMethod}`, with `koMatchMethod: 1` (binary) because
  the reader must identify a book by its content, which is what `kosync_document` records at
  delivery. Confirmed against real hardware; see the `pocket-device-protocol` skill.
  - The values are still shown in Settings, because typing them in stays the fallback and because a
    reader nobody is holding has no credentials to be given.
  - **A sync server the user configured themselves is not overwritten.** If the reader already
    reports somewhere that is not this machine and we have never configured it, the push is recorded
    as a `conflict` and skipped; the reader's page offers to take it over. After we have configured
    a reader once, it stays ours.
  - `device_settings.kosync_hash` fingerprints what the reader last accepted, so the steady state
    costs no round trip and a changed holder, port or LAN address re-pushes by itself. The write is
    read back where the firmware allows, so a 200 that dropped the fields reads as a failure rather
    than as silence later.
- Reading state persists when the source file disappears, so re-adding a file restores it.
- **Exposure**: the reader must reach us over the LAN, but the library UI must not become
  LAN-exposed by the same switch. The kosync listener binds separately, with its own generated
  credential. `webHost` stays `127.0.0.1` by default.
- Progress sync is **manual on the reader** — the user taps "Sync Progress" — so the UI must show
  freshness and must never imply live tracking.

### UI

The interface is the model: **the library, the people it is for, and the readers they hold** — in
that order, in one rail. There is no Devices tab; a reader is a page inside the library, because
what you want to know about a reader is which books are on it.

```
┌──────────────┬────────────────────────────────────────┐
│ Library  142 │  [search…]                    [Select] │
│              │                                        │
│ Stu          │  ▾ Fiction · 82          ☑ syncs here  │
│   X4    ●    │    ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪   │
│   X3    ○ 3↑ │    ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪ ▪               │
│ Sarah        │                                        │
│   X3-b  ●    │  ▸ Comics · 14           ☐ syncs here  │
│ ──────────   │                                        │
│ All          │  ▾ Reference · 0                       │
│ Reading      │    Nothing here yet — drop books onto  │
│ Unread       │    this folder to add.                 │
│ Finished     │                                        │
└──────────────┴────────────────────────────────────────┘
```

- **One shelf, three scopes.** `Shelf.tsx` renders every watched folder as a collapsible section of
  ~100px covers, and the whole library, a person and a reader all use it. What changes is only
  whether folders carry a binding checkbox. Covers are small deliberately: the shelf is for finding
  a book among hundreds, not admiring one.
- **Empty folders still get a header.** A folder you have just ticked in Settings must not look like
  it failed. While a search or reading filter is active, groups with matches force themselves open
  and empty ones drop out, so a match can never hide behind a collapsed caret. Collapse choices
  persist in `localStorage`; the default is open, except a folder that doesn't sync to the reader
  you are looking at.
- **A book in two folders appears under both.** That is what `library_book` says and what
  `/api/library` has always returned; grouping is what finally makes it read as one book in two
  places rather than a duplicate.
- **Books land in a folder, so folders are the drop target.** The section under the cursor takes the
  drop and uploads there — there is no "current folder" to guess at.
- **Per-user folder selection is a bulk edit, not a binding.** The binding stays per device
  (`LibraryConfig.deviceIds`, invariant 5): ticking a folder on a person's page adds every reader
  they currently hold, and the box shows half-ticked when only some of them have it. A reader
  assigned to them later inherits nothing, and a person holding no reader has the toggle disabled
  with the reason — there is nothing for the tick to write to. The alternative, a real `userIds`
  binding fanned out through `device_settings.user_id`, was rejected: that field means "who is
  holding this reader" and is meant to be switched freely, which would make handing someone your X3
  silently rewrite what is on it.

- **Activity** (`Activity.tsx`) is the one place for "what is the app doing": the Inbox of imports
  on top, the running log below. The Inbox itself (`Inbox.tsx`) is server-backed and streamed over
  SSE, showing real stage names, and blocked rows persist with the action that unblocks them
  (_install plugin_, _enter your reader's key_). Failed imports stop being toasts — a toast is for
  something you may ignore.
- **The shelf gets one line, not a panel** (`ActivityBar.tsx`): a labelled progress bar above the
  books which clicks through to Activity (and Activity offers the way back — arriving there is a
  detour, not a destination). Import rows pushed the books down the page for work that mostly needs
  no attention; the attention case is what the bar's warning state is for.
- **The bar only claims a percentage it actually knows.** A sync is determinate: the engine's
  `sync.book.start` carries `index` and `total`, so the fill is whole books done plus the fraction
  of the one in flight, and it never falls back mid-run. Imports are indeterminate on purpose — the
  scanner discovers files as it walks, so any denominator would grow underneath the bar and make it
  retreat, which is exactly what inferring the total from "books seen so far" did.
- **Library** (`Library.tsx`): the rail and the scope switch; the shelf itself is `Shelf.tsx`.
  Reading progress as a bar across the cover, selection behind a `Select` mode instead of a
  permanent checkbox on every card, and the dropzone revealed per folder on dragenter
  (`useGlobalDropGuard` swallows document-level drops).
- **A book's whereabouts is one dot**, top-left of the cover: green on the reader, orange on its way
  (pulsing while actually uploading), grey not set to sync anywhere. Which readers "on the reader"
  means follows the scope — this reader, this person's, or every reader the folder feeds. Naming
  them on each card was noise at 100px, and a bare count said nothing.
- **Person** (`UserView.tsx`): their readers, their page-sync credentials, and the folder ticks that
  fan out across every reader they hold.
- **Reader** (`DeviceView.tsx`): the folder ticks, and below them **Also on this reader** — only the
  files no folder accounts for (side-loaded books, and books whose file has left the folder).
  Everything a folder does account for is already on screen as covers, so the old four-column table
  of the whole device restated it. These are the files a sync deliberately never touches, so being
  visible is the whole point. **There is no Sync now button** — syncing is automatic, and a button
  implying otherwise makes the reader look like something you operate. The state that used to be
  printed under the name (address, last seen, identity, how many are waiting) is a tooltip on the
  online/offline pill. Name, holder, resampling and the two switches are behind **Edit**, saved
  live; a manual sync sits there too, for someone who has turned automatic syncing off.
- **The one thing automation cannot decide** is a bulk deletion: past `REMOVAL_CONFIRM_THRESHOLD` a
  sync stops and changes nothing, so with no Sync button the removals would wait forever.
  `plan.needsConfirm` (computed in `SyncEngine.plan()`, beside the threshold it uses) raises a
  banner on the reader's page; confirming runs the unconfirmed sync first so the warning can name
  the actual titles.
- **Discovery** (`Discovery.tsx`, in Settings): the network side only — whether the app is looking,
  whether anything has ever answered, and the readers it knows about. The three states that look
  identical from a bare "no devices yet" (discovery off, nothing configured to probe, probing but
  silent) each say which one they are.
- **Drawer** (`BookDrawer.tsx`): progress and its freshness, a manual finished toggle, fix metadata
  / fetch cover, the source file path, re-send.
- **Removed**: the Lists tab, `Lists.tsx`, `src/library/lists.ts`, the `list` / `list_item` tables,
  and the Devices tab.

## Schema

One appended migration in `src/core/db.ts`; the existing v1 array is never edited.

- `book.id` becomes MD5 hex. `original_path` points into the user's folder. Adds `library_id` and a
  `source_missing` flag.
- `file_index (path, size, mtime, md5)` — the rescan hash cache.
- `import_job (id, library_id, path, stage, state, error, needs, created_at)`.
- `reading_state (library_id, book_id, percentage, position_json, finished, finished_source,
  device_id, updated_at)`.
- `kosync_document (document_hash, book_id, profile_hash)`.
- `sync_rule` → `device_settings`: drops `source_type`, `source_list_id`, `mode`; adds `library_id`.
- Drops `list`, `list_item`.

Because ids change representation, migration **re-derives** rather than converting: keep
`device_content` rows, re-hash on the first scan, and match existing on-device files against the old
`<bookId>__<title>.epub` pattern one last time before that scheme retires.

## Roadmap

| # | Scope                                                                  | Done when                                                     |
| - | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| 0 | This document                                                          | Decisions recorded in-repo                                    |
| 1 | Watched folders, MD5 identity, scanner, hash cache, schema v2          | A folder populates the library; rename/move doesn't duplicate |
| 2 | Sync reconciliation, human filenames, embedded MD5, deletion rails     | `acceptance.sh` green, delete-on-disappear covered            |
| 3 | Inbox and the library/device/drawer UI                                 | Imports block visibly and resume; no Lists tab                |
| 4 | Staged Calibre pipeline, DRM detection, plugin install, metadata fetch | A DRM'd file reports accurately and unlocks after a key       |
| 5 | kosync listener, document mapping, finished tag                        | A real X4 reports progress; a book shows as finished          |

Phases 1–2 change data on disk; 3–5 are additive.

## Verification

- `deno task check` and `deno task test` throughout. `tests/unit_test.ts` gains cases for MD5
  identity stability across rename and move, filename collision tiebreak, and settle detection.
- `deno task acceptance` must stay green against `tests/fake_device.ts`, with new steps: a file
  removed from the folder is removed from the device; the threshold confirm blocks a bulk delete; an
  unreadable root aborts without deleting anything. The existing `--fail-upload` and `--drop-upload`
  interruption cases must keep passing.
- kosync gets a fake client posting a known payload, asserting the document maps to the right book
  and flips `finished` at 99%.
- On real hardware: confirm the firmware's filename length and charset limits with a long unicode
  title **before phase 2 locks the naming scheme**, and confirm the actual kosync document hash
  method from the first live request in phase 5.

## Out of scope

Multi-gigabyte libraries (pagination and the mtime hash cache keep the door open); user accounts;
reorganizing files _on_ the device; pointing at an existing Calibre library as a source; bundling
DeDRM.
