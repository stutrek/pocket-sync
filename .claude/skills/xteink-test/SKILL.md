---
name: xteink-test
description: How to verify changes to Xteink Sync without a physical e-reader — the fake device simulator, the end-to-end acceptance script, and how to prove optimizer output is genuinely safe for the firmware. Use after changing ingest, the optimizer, the device client or the sync engine, or when adding tests.
---

# Verifying changes

```bash
deno task test         # unit tests: ids, device paths, identity, metadata parsing
deno task acceptance   # end-to-end against a simulated reader (must stay 8/8)
deno task check        # type-check + lint + fmt
```

## The fake device

`tests/fake_device.ts` implements the confirmed device protocol backed by a local
directory: `/api/status`, `/api/files`, `/download`, `/delete`, `/mkdir` and the
WebSocket upload handshake. It rejects frames over 2048 bytes exactly as the firmware
does, and reports a `uuid` so identity resolution takes the stable path.

```bash
deno run -A tests/fake_device.ts --root /tmp/dev --http 8199 --ws 8198
# then add "127.0.0.1:8199" to Settings → Discovery → manual hosts
```

Failure injection:

- `--fail-upload N` — reject the Nth upload with `ERROR:` (retry path)
- `--drop-upload N` — write a partial file then close the socket mid-transfer
  (device-sleeps path: partial cleanup, backoff, resume on reconnect)
- `--model X3` — exercise the other device profile

A manual host may carry a non-default HTTP port (`host:8199`); the upload port comes
from `wsPort` in the status response. That is how the simulator avoids needing
privileged ports 80/81 — real hardware uses the defaults.

## The acceptance script

`tests/acceptance.sh` walks the whole product in throwaway dirs under `$TMP`: ingest
5 formats → build a list → bind an X4 profile → sync → `add_new` → `mirror` delete →
mid-transfer drop → resume → duplicate protection. It also unpacks the EPUBs that
landed on the device and asserts they are device-safe:

- `mimetype` is the first zip entry
- images are grayscale (`L`) and within 480×800 (X4) / 528×792 (X3)
- no embedded fonts (`.ttf/.otf/.woff*`) and no `@font-face`
- no `<p>` over 1600 bytes, no spine file body over the split limit

`CLEAN` in the output means all of those passed. If you touch the optimizer,
resampling profiles or the ingest pipeline, this is the check that matters.

**Sync is asynchronous.** `POST /api/devices/:id/sync` can return while a queued
rerun is still working, so the script polls `/api/status` for `syncing: false`
(`wait_idle`). Any new test that triggers a sync must do the same, or it will be
flaky in a way that looks like a product bug.

## Testing against real firmware (not yet done)

[crosspoint-simulator](https://github.com/crosspoint-reader/crosspoint-simulator)
compiles the actual CrossPoint firmware natively (SDL2 window, a local directory as
the SD card) and ships host-backed `WebServer` / `WebSocketsServer` / `NetworkClient`
shims, so the real `/api/*` routes and the real upload handler run on the desktop.
Needs PlatformIO and SDL2 (`brew install sdl2`). Pointing the daemon at it with a
manual host and re-running the acceptance script would validate the client against
firmware code rather than our stand-in. Worth doing before trusting a release.

## What is not covered

- The Windows and Linux artifacts have never been executed — only checked for
  well-formedness. See `xteink-package`.
- No test touches physical hardware; the protocol is trusted because it mirrors the
  upstream client that is known to work (see `xteink-device-protocol`).
