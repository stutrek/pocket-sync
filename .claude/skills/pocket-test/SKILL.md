---
name: pocket-test
description: How to verify changes to Pocket Sync without a physical e-reader — the fake device simulator, the end-to-end acceptance script, and how to prove optimizer output is genuinely safe for the firmware. Use after changing ingest, the optimizer, the device client or the sync engine, or when adding tests.
---

# Verifying changes

```bash
deno task test         # unit tests: ids, hashing, DRM detection, reading state, metadata
deno task acceptance   # end-to-end against a simulated reader (must stay green, currently 51 checks)
deno task check        # type-check + lint + fmt
```

## The fake device

`tests/fake_device.ts` implements the confirmed device protocol backed by a local directory:
`/api/status`, `/api/settings`, `/api/opds`, `/api/files`, `/download`, `/delete`, `/mkdir` and the
WebSocket upload handshake. `/api/settings` answers with the descriptor array real firmware sends,
not a flat object — modelling the convenient shape is what hid a client that could not parse the
real one. It rejects frames over 2048 bytes exactly as the firmware does, and reports a `uuid` so
identity resolution takes the stable path.

```bash
deno run -A tests/fake_device.ts --root /tmp/dev --http 8199 --ws 8198
# then add "127.0.0.1:8199" to Settings → Discovery → manual hosts
```

Failure injection:

- `--fail-upload N` — reject the Nth upload with `ERROR:` (retry path)
- `--drop-upload N` — write a partial file then close the socket mid-transfer (device-sleeps path:
  partial cleanup, backoff, resume on reconnect)
- `--model X3` — exercise the other device profile
- `--settings '{"koServerUrl":"https://sync.koreader.rocks"}'` — a reader already pointed at
  somebody else's sync server (the `conflict` path in `configureReader()`)
- `--settings-readonly 1` — accept a settings write and discard it, as firmware that ignores the
  fields would
- `--catalogs '[{"name":"…","url":"…",…}]'` — a reader that already has OPDS catalogs of its own

A manual host may carry a non-default HTTP port (`host:8199`); the upload port comes from `wsPort`
in the status response. That is how the simulator avoids needing privileged ports 80/81 — real
hardware uses the defaults.

## The acceptance script

`tests/acceptance.sh` walks the whole product in throwaway dirs under `$TMP`: index a watched folder
of 7 books → prove identity survives a rename and deduplicates an identical copy → bind an X4
profile → sync → add a file → remove a file → abort on an unreadable folder → hold a bulk removal
for confirmation → refuse paths outside the library root (traversal, absolute, symlink escape) →
bind a second folder and check the union → abort when one folder is missing → remove a folder
mid-import → mid-transfer drop → resume → duplicate protection → push page-sync settings to the
reader → serve the OPDS catalog and prove a pulled book is byte-identical to the synced copy → push
our catalog into the reader's own OPDS list without duplicating or trampling other entries. It also
unpacks the EPUBs that landed on the device and asserts they are device-safe:

- `mimetype` is the first zip entry
- images are grayscale (`L`) and within 480×800 (X4) / 528×792 (X3)
- no embedded fonts (`.ttf/.otf/.woff*`) and no `@font-face`
- no `<p>` over 1600 bytes, no spine file body over the split limit
- the OPF carries `pocketsync-source-md5`, which is how a delivered file maps back to a book

`CLEAN` in the output means all of those passed. If you touch the optimizer, resampling profiles or
the ingest pipeline, this is the check that matters.

**It binds its own ports (8899 for the UI, 8898 for the kosync listener, 8897 for OPDS)** and aborts
if the first is taken. Without this it would happily drive a running `deno task dev` — every request
landing on your real library, with temp folders written into your real config. If you add a test
daemon anywhere, give it a dedicated port too.

**Sync is asynchronous.** `POST /api/devices/:id/sync` can return while a queued rerun is still
working, so the script polls `/api/status` for `syncing: false` (`wait_idle`). Any new test that
triggers a sync must do the same, or it will be flaky in a way that looks like a product bug.

**Scanning is asynchronous too**, and the watcher fires its own scans.
`POST /api/libraries/:id/scan` awaits whatever pass is in flight and returns that pass's real result
— do not "fix" it to return early, because the sync engine reads an empty folder as permission to
delete.

**Identical content is one book.** A test that copies a file to make "a new book" will not get one —
identity is the content hash. Write genuinely different bytes.

## Testing against real firmware (not yet done)

[crosspoint-simulator](https://github.com/crosspoint-reader/crosspoint-simulator) compiles the
actual CrossPoint firmware natively (SDL2 window, a local directory as the SD card) and ships
host-backed `WebServer` / `WebSocketsServer` / `NetworkClient` shims, so the real `/api/*` routes
and the real upload handler run on the desktop. Needs PlatformIO and SDL2 (`brew install sdl2`).
Pointing the daemon at it with a manual host and re-running the acceptance script would validate the
client against firmware code rather than our stand-in. Worth doing before trusting a release.

## What is not covered

- The Windows and Linux artifacts have never been executed — only checked for well-formedness. See
  `pocket-package`.
- No test touches physical hardware; the protocol is trusted because it mirrors the upstream client
  that is known to work (see `pocket-device-protocol`).
