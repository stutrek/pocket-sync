# Pocket Sync

A self-hosted book-sync daemon for **Xteink X3/X4** e-readers running **CrossInk / CrossPoint**
firmware. Point it at a folder of books, send the ones you want to your reader — resampled for the
low-memory device and pushed whenever it appears on Wi-Fi. One macOS menu-bar app is both the daemon
and the UI.

**Sending one book is the basic action; a folder rule automates it.** Press ＋ on a cover to send
that book to your reader. When you notice you keep sending everything out of one folder, give that
folder a rule and it keeps itself in step — new files arrive on their own, deleted ones come off.

**The filesystem is the source of truth.** Pocket Sync indexes your folder in place and never writes
to it. See [docs/DESIGN.md](docs/DESIGN.md) for the model and the reasoning behind it.

It is not a Calibre replacement. It drives Calibre's `ebook-convert` for format conversion and
reuses the CrossPoint plugin's optimizer and protocol client verbatim (see
[Vendored engine](#vendored-engine)).

```
        ┌──────────────── PocketSync.app (one Deno process) ───────────────┐
        │  menu-bar tray  ·  window  ·  HTTP + web UI  ·  SQLite           │
browser ┤  watched folders → ingest → resample cache → sync engine        │
        │  device manager: UDP discovery, /api/*, WebSocket upload         │
        └───────────────────────────┬─────────────────────────────────────┘
                                    │ Wi-Fi
                             Xteink X3 / X4
```

## Install

Download the file for your machine, open it, and you are done — there is no setup step. Each build
carries its own Python runtime for the image resampler and unpacks it on first launch.

| Platform              | Download                          | Notes                              |
| --------------------- | --------------------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `PocketSync-macos-arm64.dmg`      | Open, drag to Applications, launch |
| macOS (Intel)         | `PocketSync-macos-x64.dmg`        | Same                               |
| Windows (x64)         | `PocketSync-windows-x64.msi`      | Double-click to install            |
| Linux (x64)           | `PocketSync-linux-x64.AppImage`   | `chmod +x`, then run               |
| Linux (arm64)         | `PocketSync-linux-arm64.AppImage` | Same                               |

The app lives in the menu bar / tray. Click it to open the library, or browse to
<http://127.0.0.1:8787> from any browser on the machine. Turn on **Settings → Start Pocket Sync at
login** to have it come back after a reboot.

These builds are signed ad hoc, not with a paid developer certificate, so the OS will warn on first
launch:

- **macOS** — right-click the app and choose _Open_, or run
  `xattr -dr com.apple.quarantine /Applications/PocketSync.app`
- **Windows** — SmartScreen: _More info_ → _Run anyway_

**Calibre is optional.** EPUB files sync without it. Converting anything else (MOBI, AZW3, PDF,
DOCX, FB2, TXT…) uses Calibre's command-line tools, so install
[Calibre](https://calibre-ebook.com/download) if you want those. The app finds it automatically and
shows a banner while it is missing.

## Development

```bash
deno task setup       # dev only: venv + vendored engine for a source checkout
deno task dev         # headless daemon + web UI on http://127.0.0.1:8787
deno task desktop     # menu-bar app, built and run from source
```

### Choosing your books folder

On first run, pick the one folder that holds your books — **+ Add books** in the sidebar opens your
system's folder chooser. Everything it watches lives inside that folder, and you tick which folders
within it to watch. Watching a folder puts its books in your library; it does not by itself put them
on a reader.

There is deliberately no way to type a path. Indexed files are readable and deletable through the
API, so accepting an arbitrary path would make it an arbitrary-file API — a real concern if you ever
set `webHost` to `0.0.0.0`. Choosing the root only works from the machine the app runs on; a browser
elsewhere on your network can tick and untick folders but can never point it somewhere new.

### Connecting the reader

UDP broadcast discovery is tried first, but many networks block it. If the reader doesn't show up
under **Settings → Readers**, put its IP in **Settings → Discovery → manual hosts** — that path is
first-class and needs no broadcast. A manual host may include a non-default HTTP port
(`192.168.1.50:8080`); the upload port comes from discovery, from `/api/status`, or defaults to 81.

The first time a reader turns up, a card at the top of the library asks for a name and who is
holding it. That is the whole setup: resampling defaults to the reader's model, and page sync and
the catalog are pushed to it automatically.

After that the reader appears in the rail under its holder, and becomes the destination in the
toolbar's **Sending to** picker.

### Putting books on it

- **One book:** hover a cover and press **＋**. It goes on the next time the reader is awake.
- **Several:** press **Select**, tick them, and use **Send N to …**.
- **A whole folder, always:** open the reader and add a folder rule (`Always send: …`). Everything
  in that folder stays in step from then on.

A ✓ on a cover means the book is on the reader named in the toolbar. A grey ✓ means a folder rule
put it there — un-sending would do nothing, because the rule would put it straight back; drop the
rule instead. Un-sending a book you sent by hand takes it off on the next sync.

## How syncing works

1. Each watched folder is scanned; a file's **MD5 is its book id**, cached against
   `(path, size, mtime)` so a rescan only rehashes what changed.
2. Device answers `/api/status` → identity and model (X3/X4).
3. `/api/files` is walked recursively for what's already there.
4. `send = wanted − on device`, `remove = on device − wanted`, where "wanted" is every book a folder
   rule covers plus every book you sent to that reader by hand.
5. Each new book is converted to EPUB (once) and optimized for the profile (once, cached as
   `opt-<hash>.epub`), then uploaded over WebSocket in ≤2048-byte frames.

Details worth knowing:

- **Identity is the file's content**, so renaming or moving a book in your folder is a no-op, and
  the same file in two folders is one book sharing one optimized copy.
- **Device filenames are readable** — `Title - Author.epub`. The source MD5 is stamped into the
  delivered EPUB's OPF metadata, so a file found on a reader can still be matched to a book.
- **Only files Pocket Sync put there are ever deleted** — side-loaded books survive.
- **A book leaves when nothing puts it there any more** — no send, no rule covering it. Deleting a
  book's file un-sends it too: there is nothing left to send.
- **Bulk deletions ask first.** Removing more than five books in one sync pauses for confirmation,
  and dropping a folder rule that would clear that many refuses until you confirm. Un-sending never
  asks — you pointed at the book and said so. A folder that is missing or unreadable aborts the sync
  entirely rather than being read as "zero books", including when only one of several is away, so an
  unplugged drive can't wipe your reader.
- **Device identity** comes from a stable field in `/api/status` (`uuid`, `serial`, …) so DHCP can
  move the reader freely. If the firmware exposes nothing stable, the device is bound by address and
  the UI says so; rename it and it stays put as long as there's only one reader of that model.
- **Interruptions are safe.** A device that sleeps mid-sync leaves no partial file (the partial is
  deleted, then retried with backoff), and the remaining books go out on the next connection.
- **Optimization is cached per profile**, keyed on every setting that changes the output _and_ on
  the vendored engine version, so bumping the engine invalidates stale copies automatically.

## Reading progress

CrossPoint firmware includes a KOReader sync client, so Pocket Sync can be its server and learn how
far you have read. It is on by default and sets itself up: say who is holding a reader on that
reader's page, and its address and credentials are written to the reader the next time it syncs.

The reader keeps whatever you set up yourself — if it already reports to another sync server, Pocket
Sync leaves it alone and the reader's page offers to take it over. To do it by hand, open **Settings
→ System → KOReader Sync** on the reader and enter the address and credentials shown in Settings.

Progress arrives when you tap _Sync Progress_ on the device — it is not continuous. A book past 99%
is tagged **finished**; you can also set or clear that by hand, and your choice outranks the reader.

The sync listener binds separately from the library UI, so enabling it does not put your library on
the network. `webHost` stays `127.0.0.1` unless you change it.

## Browsing the library from a reader (OPDS)

Pocket Sync can also publish the library as an **OPDS catalog**, so a reader or a phone can come and
fetch a book instead of waiting to be sent one. Turn it on in Settings; it is off by default, and it
binds its own port (8789) rather than sharing the library UI's.

Each reader gets its own catalog address, and CrossPoint firmware has an OPDS browser built in, so
Pocket Sync adds itself to the reader's catalog list for you — no typing on the e-ink keyboard. It
edits its own entry rather than adding another one each time, and any catalog you added yourself is
left alone. The device is part of that address, and that is what makes it safe: a book pulled
through it arrives already resampled for that reader, out of the same cache the normal sync uses,
and page sync still recognises it. Any other OPDS client — KOReader on a phone, Calibre, Thorium —
can use the plain address instead and will get the original file; add `?profile=<id>` if you want a
resampled one.

There is no password. Sign in as anybody if your client insists, or add `?user=<your name>` to see
your own reading progress; the password is ignored either way. That is a deliberate trade for a home
network, and it has a real consequence worth knowing before you switch it on: **anything that can
reach that port can download your books.** Nothing there can write, delete, or see anything outside
the folders you already watch — but if that is not a trade you want, leave it off.

## Books you already have

If your books are already in **Calibre**, **Adobe Digital Editions**, **Apple Books** or **Kobo
desktop**, Pocket Sync finds those libraries and offers to watch them where they are. Nothing is
copied and nothing is moved: buy a book in Calibre and it appears here on its own.

**Look inside** first tells you what you'd actually be adding — how many books, how many are
protected, and whether anything needs setting up — before anything is watched.

These libraries are **read-only, always**. Pocket Sync never writes into one, and _Delete file_ is
not offered for their books; the files belong to the app that made them. Un-watching a source
removes it from Pocket Sync and deletes nothing. Because they sit outside your books folder, the
whole panel only works on the machine running Pocket Sync — a browser elsewhere on your network
can't see or enable them.

Three things worth knowing: Apple Books store purchases use FairPlay and cannot be opened by
anything Pocket Sync can drive (only books you added yourself will import); Kobo `.kepub` files need
Calibre's Obok plugin rather than DeDRM; and **Kindle for Mac/PC is deliberately not offered** —
Amazon's current KFX DRM cannot be removed by any available tool, so the honest answer is to add
those books to Calibre, which is supported.

## DRM

DRM removal runs inside **your own Calibre**, never inside Pocket Sync — DeDRM is a Calibre
file-type plugin that only fires on `calibredb add`. Pocket Sync detects a protected file itself,
routes it through `calibredb` into a throwaway library, and takes the cleaned result.

If you already set DeDRM up in Calibre, nothing more is needed. Otherwise the Inbox walks you
through whatever is actually missing:

| What it says                       | What to do                                                      |
| ---------------------------------- | --------------------------------------------------------------- |
| _needs the DeDRM plugin_           | **Install plugin** — fetched from GitHub into your Calibre      |
| _the DeDRM plugin is switched off_ | Enable it in Calibre → Preferences → Plugins                    |
| _no key that opens this book_      | **Add a key** — see below                                       |
| _none of your keys open it_        | The book was bought on a different account; nothing will fix it |
| _Calibre is open_                  | Quit Calibre — it locks its database and `calibredb` cannot run |

### Which key do you need?

It depends where the book came from, and **a Kindle serial number is not a general-purpose key**:

- **Books downloaded by Kindle for Mac or PC** are encrypted to the app installed on this machine,
  not to any serial. DeDRM finds that key itself the first time it meets one of those books, so
  there is usually nothing to do.
- **Books transferred to an e-ink Kindle over USB** are encrypted to _that specific device_, so they
  need that device's own 16-character serial (on the reader, under Settings → Device Info). A serial
  from a different Kindle will never work, and it will not help with a book the desktop app
  downloaded.
- **Adobe Digital Editions** books need nothing: DeDRM finds that key itself.

Keys live in Calibre's own configuration and only there. Pocket Sync can _add_ a Kindle serial to
it, and lists what is configured under **Settings → Reader keys**, but stores nothing itself and
never sends a key anywhere. Those screens are only available on the machine running Pocket Sync,
even if you have opened the web UI to your network.

### Kindle KFX

Books the Kindle desktop app downloads use **KFX**, and its DRM cannot be removed by any available
tool. Tested end to end against a real library: DeDRM fails with _"Unknown type encountered in
envelope, expected VoucherEnvelope"_ — its last release predates the format and the project has been
dormant since 2024. No key, serial or plugin changes this.

So Pocket Sync does not offer the Kindle app as a library, and a `.kfx` file dropped in a watched
folder is listed in the Inbox with that explanation rather than being silently ignored. If your
Kindle books are already usable, they are almost certainly in Calibre — point Pocket Sync at that.

## Resampling profiles

A profile is what the CrossPoint optimizer is told to do:

| Field          | Meaning                                                     |
| -------------- | ----------------------------------------------------------- |
| `device_model` | `X4` (480×800) or `X3` (528×792)                            |
| `jpeg_quality` | 1–100, default 85                                           |
| `grayscale`    | recommended on for e-ink                                    |
| `auto_crop`    | trim solid page margins                                     |
| `split_text`   | split huge paragraphs/files, strip embedded fonts — keep on |

`split_text` is what keeps books from crashing the firmware's layout engine on its ~380 KB of RAM.
Two profiles (`X4 default`, `X3 default`) are seeded on first run. Preview exactly what a device
would receive:

```
GET /api/books/<id>/optimized?profile=<profileId>
```

## Vendored engine

`engine/vendor/crosspoint_reader/` holds **unmodified** third-party files (MIT), pinned by commit in
`engine/fetch_vendor.sh`. They currently come from
[stutrek/calibre-plugins](https://github.com/stutrek/calibre-plugins) — a fork of
[crosspoint-reader/calibre-plugins](https://github.com/crosspoint-reader/calibre-plugins) carrying
two fixes: images are encoded as PNG when that beats JPEG (forcing JPEG made flat artwork ~6×
larger), and named HTML entities are replaced with numeric ones (the rewrite drops the DOCTYPE that
declared them). Both are meant to go upstream, after which the pin moves back.

| File           | Used for                                  |
| -------------- | ----------------------------------------- |
| `optimizer.py` | firmware-matched image/EPUB optimization  |
| `textsplit.py` | paragraph/file splitting, font stripping  |
| `ws_client.py` | UDP discovery + WebSocket upload protocol |

`engine/sidecar.py` (ours) is a thin JSON-lines wrapper the daemon talks to over stdin/stdout; it
marshals arguments and streams progress, and reimplements nothing. To pull upstream fixes in:

```bash
CROSSPOINT_PIN=<new-sha> deno task vendor && deno task build
CROSSPOINT_REPO=owner/repo CROSSPOINT_PIN=<sha> deno task vendor   # from a fork
```

The device's plain HTTP calls (`/api/status`, `/api/files`, `/delete`, `/mkdir`, `/download`, WebDAV
`PUT`) are implemented in TypeScript in `src/device/client.ts`, matching the request shapes
`driver.py` uses.

## Layout

```
src/core/      config, SQLite schema + migrations, logging, event bus, ids, hashing
src/library/   folder scanner, ingest pipeline, DRM detection, Calibre wrappers, import inbox
src/engine/    Python sidecar supervisor; engine files embedded in the binary
src/device/    device HTTP client, discovery + registry, identity
src/sync/      resample profiles + cache, sync engine, reading state, kosync server
src/web/       HTTP API, Preact UI sources (ui/), bundled output + shell (static/)
src/desktop/   Deno.Tray + Deno.BrowserWindow shell (loaded only when present)
engine/        sidecar.py, fetch_vendor.sh, vendored upstream modules
tests/         unit tests, fake device, end-to-end acceptance script
```

The services in `src/core`, `src/library`, `src/device` and `src/sync` have no GUI dependency:
`deno task start` runs the whole daemon headless.

## Testing

```bash
deno task test         # unit tests (ids, paths, identity, metadata parsing)
deno task acceptance   # end-to-end against a simulated reader
deno task check        # type-check + lint + format check
```

`tests/fake_device.ts` is a stand-in CrossInk reader implementing the confirmed protocol; it can
simulate a failing upload (`--fail-upload N`) or a device that sleeps mid-transfer
(`--drop-upload N`). `tests/acceptance.sh` walks the whole model: index a folder → content identity
survives renames and deduplicates copies → optimize → sync → add → remove → unreadable-folder abort
→ bulk-removal confirmation → interruption → resume. It verifies on-device EPUBs really are
grayscale, ≤480×800, font-free, within the firmware's paragraph/file size limits, and stamped with
their source hash. It binds its own port (8899) so it never talks to a running `deno task dev`.

## Data and configuration

Everything lives in `~/Library/Application Support/pocket-sync/` (override with `POCKET_DATA_DIR`):

```
db.sqlite                  index, devices, settings, manifest, reading state
library/<md5>/             book.epub, opt-<hash>.epub, cover.jpg (derived only)
logs/pocket-sync.log       rotating JSONL, mirrored to the UI and tray
config.json                paths, discovery, upload, log level
engine/                    materialized sidecar + .venv
```

`engine/` holds the unpacked Python runtime and sidecar; deleting it is safe — the app rebuilds it
on the next launch.

Settings are editable in the UI. Port and bind-address changes need a restart. `webHost` defaults to
`127.0.0.1`; set it to `0.0.0.0` only if you want other machines on your LAN to reach the library
(there is no authentication).

## Building distributables

```bash
deno task package          # this platform
deno task package --all    # every platform, from one machine
```

`scripts/fetch_python.ts` downloads a stripped
[python-build-standalone](https://github.com/astral-sh/python-build-standalone) CPython for the
target and installs Pillow + lxml wheels for that platform into it; `scripts/package.ts` embeds the
result with `deno desktop --include` and picks the packaging format from the output extension.
Cross-compiling needs no platform toolchain — Deno fetches prebuilt runtimes — so all five artifacts
build from a single macOS or Linux host. Roughly 55–75 MB each, about 35 MB of which is the Python
runtime.

Building for a source checkout instead:

- **Requirements**: Deno 2.9+ (for the `deno desktop` subcommand). Calibre optional, as above.
- `deno task build` produces a plain `dist/PocketSync.app` without the bundled runtime; use
  `deno task package` for anything you intend to hand to someone else.

## Licence

`optimizer.py`, `textsplit.py` and `ws_client.py` are MIT, © CrossPoint Reader — see
`engine/vendor/LICENSE`. They are redistributed unmodified.
