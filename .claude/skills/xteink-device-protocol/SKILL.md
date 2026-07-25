---
name: xteink-device-protocol
description: The CrossInk/CrossPoint device protocol (discovery, HTTP API, WebSocket upload) and the rules for the vendored upstream Python engine — including how to pull upstream fixes in and why these files must never be edited. Use when touching src/device/, src/engine/, engine/, the sync upload path, or the resampling optimizer.
---

# Device protocol and the vendored engine

## Reuse, don't reimplement

Three upstream files from
[crosspoint-reader/calibre-plugins](https://github.com/crosspoint-reader/calibre-plugins)
(MIT) live **byte-identical** in `engine/vendor/crosspoint_reader/`:

| File | Provides |
| --- | --- |
| `optimizer.py` | firmware-matched image/EPUB optimization |
| `textsplit.py` | paragraph/file splitting, embedded-font stripping |
| `ws_client.py` | UDP discovery + WebSocket upload |

**Never edit them.** The whole point is that upstream fixes arrive by bumping a pin:

```bash
CROSSPOINT_PIN=<new-sha> deno task vendor && deno task package
```

Notes that matter:

- `optimizer.py` and `textsplit.py` import each other *relatively*, so the vendored
  files must form a package. `fetch_vendor.sh` generates the only file we add,
  `__init__.py`.
- Pillow and lxml are imported lazily inside functions — that is why a missing
  dependency surfaces as a runtime error, not an import error.
- Device profiles come from upstream: **X4 = 480×800, X3 = 528×792** (portrait,
  short × long).
- Bumping the pin changes `ENGINE_VERSION` (`src/engine/assets.ts`), which feeds
  `profileHash()` — every cached `opt-<hash>.epub` invalidates automatically. Don't
  defeat that.

`engine/sidecar.py` is ours: a thin JSON-lines wrapper (`ping`, `optimize`,
`discover`, `upload`) that marshals arguments and streams progress. One thread per
command, serialized stdout. It must stay thin — logic belongs upstream or in TS.

The engine files are embedded in the binary as text (`src/engine/assets.ts`) and
materialized into `<dataDir>/engine/` at startup, because a subprocess cannot exec
from the embedded VFS.

## Protocol (confirmed working — mirrors the upstream client)

### Discovery
UDP broadcast of the ASCII payload `hello` to ports
`8134, 54982, 48123, 39001, 44044, 59678`. A reply whose text starts with
`crosspoint` identifies the device; an optional `;<port>` suffix carries the
WebSocket port (default **81**). Done by vendored `ws_client.discover_device`, not
reimplemented.

Broadcast is frequently blocked on real networks, so **manual hosts are
first-class**, not a fallback — plus an optional hotspot probe at `192.168.4.1`.

### HTTP API — `http://<host>` (port 80), implemented in `src/device/client.ts`
| Call | Shape |
| --- | --- |
| `GET /api/status` | `{"device":"X3"\|"X4", …}` — model + identity fields |
| `GET /api/files?path=/` | `[{name, isDirectory, isEpub, size}]`, recurse yourself |
| `GET /download?path=<p>` | raw bytes |
| `POST /delete` | form field `paths` = **JSON array string** |
| `POST /mkdir` | form fields `name`, `path` — one level at a time |
| `PUT /<path>` | WebDAV; last-resort delivery after WS retries |

Firmware quirks already handled: `mkdir` returns 400 (or hangs) when the folder
exists, so any error is re-checked against the listing; paths are normalized to
forward slashes with a single leading slash.

### WebSocket upload — `ws://<host>:<port>/`
1. text `START:<filename>:<size>:<path>` (`<path>` = target **directory**)
2. await text `READY` (or `ERROR:<msg>`)
3. stream binary frames, **≤ 2048 bytes each** (hard firmware cap), draining any
   incoming text between chunks
4. await text `DONE` (or `ERROR:<msg>`)

On failure after bytes were sent, `POST /delete` the partial path, then retry with
backoff. `uploadStarted` comes back through `SidecarError.uploadStarted` so the
engine knows whether cleanup is needed.

**Pass `client.hostname` to the upload, not `client.host`** — `host` may include a
non-default HTTP port, which is not the WebSocket port. This has bitten before.

## Device identity

`stableIdentity()` in `src/device/manager.ts` scans `/api/status` for `uuid`,
`serial`, `chipId`, `mac`, … and hashes the first plausible value. Only if nothing
stable exists does it fall back to an address-derived id — in which case a single
known device of the same model is reused rather than duplicated when DHCP moves it,
and the UI says the identity is address-bound. Never key device rows on IP.
