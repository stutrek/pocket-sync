# Xteink Sync

A self-hosted book-sync daemon for **Xteink X3/X4** e-readers running **CrossInk / CrossPoint**
firmware. It keeps a personal library and pushes books — resampled for the low-memory device — to
the reader whenever it appears on Wi-Fi. One macOS menu-bar app is both the daemon and the UI.

It is not a Calibre replacement. It drives Calibre's `ebook-convert` for format conversion and
reuses the CrossPoint plugin's optimizer and protocol client verbatim (see
[Vendored engine](#vendored-engine)).

```
        ┌──────────────── XteinkSync.app (one Deno process) ───────────────┐
        │  menu-bar tray  ·  window  ·  HTTP + web UI  ·  SQLite           │
browser ┤  library / lists / ingest  →  resample cache  →  sync engine     │
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
| macOS (Apple Silicon) | `XteinkSync-macos-arm64.dmg`      | Open, drag to Applications, launch |
| macOS (Intel)         | `XteinkSync-macos-x64.dmg`        | Same                               |
| Windows (x64)         | `XteinkSync-windows-x64.msi`      | Double-click to install            |
| Linux (x64)           | `XteinkSync-linux-x64.AppImage`   | `chmod +x`, then run               |
| Linux (arm64)         | `XteinkSync-linux-arm64.AppImage` | Same                               |

The app lives in the menu bar / tray. Click it to open the library, or browse to
<http://127.0.0.1:8787> from any browser on the machine. Turn on **Settings → Start Xteink Sync at
login** to have it come back after a reboot.

These builds are signed ad hoc, not with a paid developer certificate, so the OS will warn on first
launch:

- **macOS** — right-click the app and choose _Open_, or run
  `xattr -dr com.apple.quarantine /Applications/XteinkSync.app`
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

### Connecting the reader

UDP broadcast discovery is tried first, but many networks block it. If the reader doesn't show up
under **Devices**, put its IP in **Settings → Discovery → manual hosts** — that path is first-class
and needs no broadcast. A manual host may include a non-default HTTP port (`192.168.1.50:8080`); the
upload port comes from discovery, from `/api/status`, or defaults to 81.

Then set the device's sync rule: **source** (whole library or one list), **mode** (`add new` or
`mirror`), and a **resampling profile**. With auto-sync on, waking the reader syncs it.

## How syncing works

1. Device answers `/api/status` → identity and model (X3/X4).
2. `/api/files` is walked recursively for what's already there.
3. Desired set comes from the rule; `new = desired − on device`.
4. Each new book is converted to EPUB (once, at ingest) and optimized for the profile (once, cached
   as `opt-<hash>.epub`), then uploaded over WebSocket in ≤2048-byte frames.
5. `mirror` also deletes books that left the source.

Details worth knowing:

- **Book identity on the device** is the filename `<bookId>__<title>.epub`, so a lost database can
  be reconstructed from the device listing alone. The local manifest is preferred; filenames are the
  fallback.
- **`mirror` only deletes what Xteink Sync put there** — files it doesn't recognise are left alone
  and logged. Side-loaded books survive a mirror sync.
- **Device identity** comes from a stable field in `/api/status` (`uuid`, `serial`, …) so DHCP can
  move the reader freely. If the firmware exposes nothing stable, the device is bound by address and
  the UI says so; rename it and it stays put as long as there's only one reader of that model.
- **Interruptions are safe.** A device that sleeps mid-sync leaves no partial file (the partial is
  deleted, then retried with backoff), and the remaining books go out on the next connection.
- **Optimization is cached per profile**, keyed on every setting that changes the output _and_ on
  the vendored engine version, so bumping the engine invalidates stale copies automatically.

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

`engine/vendor/crosspoint_reader/` holds **unmodified** upstream files from
[crosspoint-reader/calibre-plugins](https://github.com/crosspoint-reader/calibre-plugins) (MIT),
pinned by commit in `engine/fetch_vendor.sh`:

| File           | Used for                                  |
| -------------- | ----------------------------------------- |
| `optimizer.py` | firmware-matched image/EPUB optimization  |
| `textsplit.py` | paragraph/file splitting, font stripping  |
| `ws_client.py` | UDP discovery + WebSocket upload protocol |

`engine/sidecar.py` (ours) is a thin JSON-lines wrapper the daemon talks to over stdin/stdout; it
marshals arguments and streams progress, and reimplements nothing. To pull upstream fixes in:

```bash
CROSSPOINT_PIN=<new-sha> deno task vendor && deno task build
```

The device's plain HTTP calls (`/api/status`, `/api/files`, `/delete`, `/mkdir`, `/download`, WebDAV
`PUT`) are implemented in TypeScript in `src/device/client.ts`, matching the request shapes
`driver.py` uses.

## Layout

```
src/core/      config, SQLite schema + migrations, logging, event bus, ids
src/library/   ingest pipeline, Calibre CLI wrappers, books, lists
src/engine/    Python sidecar supervisor; engine files embedded in the binary
src/device/    device HTTP client, discovery + registry, identity
src/sync/      resample profiles + cache, sync engine (add_new / mirror)
src/web/       HTTP API and the no-build web UI
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
(`--drop-upload N`). `tests/acceptance.sh` walks the whole brief: ingest → list → optimize → sync →
add_new → mirror → interruption → resume, verifying on-device EPUBs really are grayscale, ≤480×800,
font-free and within the firmware's paragraph/file size limits.

## Data and configuration

Everything lives in `~/Library/Application Support/xteink-sync/` (override with `XTEINK_DATA_DIR`):

```
db.sqlite                  library, lists, devices, rules, manifest
library/<bookId>/          original.<ext>, book.epub, opt-<hash>.epub, cover.jpg
logs/xteink-sync.log       rotating JSONL, mirrored to the UI and tray
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
- `deno task build` produces a plain `dist/XteinkSync.app` without the bundled runtime; use
  `deno task package` for anything you intend to hand to someone else.

## Licence

`optimizer.py`, `textsplit.py` and `ws_client.py` are MIT, © CrossPoint Reader — see
`engine/vendor/LICENSE`. They are redistributed unmodified.
