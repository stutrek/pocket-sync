---
name: pocket-device-protocol
description: The CrossInk/CrossPoint device protocol (discovery, HTTP API, WebSocket upload) and the rules for the vendored upstream Python engine — including how to pull upstream fixes in and why these files must never be edited. Use when touching src/device/, src/engine/, engine/, the sync upload path, or the resampling optimizer.
---

# Device protocol and the vendored engine

## Reuse, don't reimplement

Three upstream files from
[crosspoint-reader/calibre-plugins](https://github.com/crosspoint-reader/calibre-plugins) (MIT) live
**byte-identical** in `engine/vendor/crosspoint_reader/`:

| File           | Provides                                          |
| -------------- | ------------------------------------------------- |
| `optimizer.py` | firmware-matched image/EPUB optimization          |
| `textsplit.py` | paragraph/file splitting, embedded-font stripping |
| `ws_client.py` | UDP discovery + WebSocket upload                  |

**Never edit them.** The whole point is that fixes arrive by bumping a pin:

```bash
CROSSPOINT_PIN=<new-sha> deno task vendor && deno task package
CROSSPOINT_REPO=owner/repo CROSSPOINT_PIN=<sha> deno task vendor   # a fork
```

### The pin is currently a fork

`engine/fetch_vendor.sh` points at **`stutrek/calibre-plugins`**, which is upstream plus two fixes
we hit in practice:

- **images are encoded as JPEG _or_ PNG, whichever is smaller.** The firmware decodes both
  (`ImageDecoderFactory.cpp`: JPEGDEC and PNGdec), and forcing JPEG inflated flat 2-colour artwork
  about 6× — a real 492 KB book came out at 778 KB — while putting ringing artifacts around the line
  art it hurts most. Same book on the fork: 464 KB.
- **named HTML entities become numeric ones.** The lxml round-trip drops the DOCTYPE, and with no
  DTD a surviving `&nbsp;` is a fatal undefined-entity error. 31 of 33 files in that book were
  affected.

Both belong upstream. When they land there, set `REPO` back to `crosspoint-reader/calibre-plugins`
and re-pin — that override exists so this stays a pin change rather than a local patch, which is the
one thing that must never happen to these files.

Consequence for tests: the optimizer now emits **mode `P`** (indexed) PNGs as well as mode `L`
JPEGs. `tests/acceptance.sh` checks that every palette entry is gray rather than that the mode is
`L`; keep it that way, since "indexed" and "colour" are not the same claim.

Notes that matter:

- `optimizer.py` and `textsplit.py` import each other _relatively_, so the vendored files must form
  a package. `fetch_vendor.sh` generates the only file we add, `__init__.py`.
- Pillow and lxml are imported lazily inside functions — that is why a missing dependency surfaces
  as a runtime error, not an import error.
- Device profiles come from upstream: **X4 = 480×800, X3 = 528×792** (portrait, short × long).
- Bumping the pin changes `ENGINE_VERSION` (`src/engine/assets.ts`), which feeds `profileHash()` —
  every cached `opt-<hash>.epub` invalidates automatically. Don't defeat that.

`engine/sidecar.py` is ours: a thin JSON-lines wrapper (`ping`, `optimize`, `discover`, `upload`)
that marshals arguments and streams progress. One thread per command, serialized stdout. It must
stay thin — logic belongs upstream or in TS.

The engine files are embedded in the binary as text (`src/engine/assets.ts`) and materialized into
`<dataDir>/engine/` at startup, because a subprocess cannot exec from the embedded VFS.

## Protocol (confirmed working — mirrors the upstream client)

### Discovery

UDP broadcast of the ASCII payload `hello` to ports `8134, 54982, 48123, 39001, 44044, 59678`. A
reply whose text starts with `crosspoint` identifies the device; an optional `;<port>` suffix
carries the WebSocket port (default **81**). Done by vendored `ws_client.discover_device`, not
reimplemented.

Broadcast is frequently blocked on real networks, so **manual hosts are first-class**, not a
fallback — plus an optional hotspot probe at `192.168.4.1`.

### HTTP API — `http://<host>` (port 80), implemented in `src/device/client.ts`

| Call                     | Shape                                                   |
| ------------------------ | ------------------------------------------------------- |
| `GET /api/status`        | `{"device":"X3"\|"X4", …}` — model + identity fields    |
| `GET /api/settings`      | array of **descriptors** — see below, not a flat object |
| `POST /api/settings`     | **JSON** body, partial — only the named fields change   |
| `GET /api/files?path=/`  | `[{name, isDirectory, isEpub, size}]`, recurse yourself |
| `GET /download?path=<p>` | raw bytes                                               |
| `POST /delete`           | form field `paths` = **JSON array string**              |
| `POST /mkdir`            | form fields `name`, `path` — one level at a time        |
| `GET /api/opds`          | the reader's own OPDS catalog list                      |
| `POST /api/opds`         | add a catalog, or edit one by `index`                   |
| `PUT /<path>`            | WebDAV; last-resort delivery after WS retries           |

Firmware quirks already handled: `mkdir` returns 400 (or hangs) when the folder exists, so any error
is re-checked against the listing; paths are normalized to forward slashes with a single leading
slash.

### `/api/settings` reads and writes different shapes

Confirmed against a real X3 on **1.4.0-tiny**. The write takes a flat partial object, but the read
answers with an array of descriptors:

```json
[{ "key": "koServerUrl", "name": "Sync Server URL", "category": "KOReader Sync",
   "type": "string", "value": "" }, …]
```

64 of them, in six categories (Display, Reader, Controls, System, KOReader Sync, Customise Status
Bar). An array is still `typeof "object"`, so reading a field straight off the response yields
`undefined` for every key — which reads as "the reader kept nothing", turns a successful write into
a reported failure, and (because a failed result stores no fingerprint) re-pushes on every sync
forever. `flattenSettings()` in `src/device/client.ts` normalizes both shapes; go through it.

### The reader's OPDS catalog list

The firmware is an OPDS **client**, and its catalogs are a collection resource — not a setting.
`GET /api/opds`:

```json
[{
  "index": 0,
  "name": "…",
  "url": "…",
  "username": "…",
  "filenameFormat": "title_author",
  "hasPassword": true
}]
```

`POST /api/opds` with `{name, url, username, filenameFormat, password}` **appends**; include `index`
and it **edits that slot** instead. Get that wrong and every sync adds another copy — so
`configureCatalog()` in `src/sync/engine.ts` always finds our entry (by `name`, falling back to the
`/opds/d/<deviceId>` path) and edits it. `filenameFormat` is at least `title_author` /
`author_title`; the reader names the downloaded file itself, which is a second reason the OPF stamp
rather than the filename carries identity.

`hasPassword` is a boolean, never the password: the firmware does not read one back, so whether the
stored password is still ours is not a question this endpoint can answer. Omitting `password` on an
edit keeps the stored one.

Nothing in the 64 settings relates to OPDS — this endpoint is the only way in.

### Configuring the reader's KOReader Sync client

`POST /api/settings` is what the reader's own settings page uses, and it takes a partial JSON body —
confirmed from the real request:

```
POST /api/settings   {"koUsername":"…","koPassword":"…","koServerUrl":"http://…","koMatchMethod":1}
```

`koMatchMethod`: **1 = binary** (hash of the file the reader holds), **0 = filename**. Always send 1
— `kosync_document` records both MD5s of the bytes we deliver, so a content hash resolves to the
right book and a filename match would not survive a retitle.

`configureReader()` in `src/sync/engine.ts` owns this: it runs at the top of every sync, skips the
round trip when the fingerprint of what the reader accepted still matches, and leaves a sync server
the user set up themselves alone unless forced. Whether `GET /api/settings` answers is treated as
unknown — every path has to work without it.

### WebSocket upload — `ws://<host>:<port>/`

1. text `START:<filename>:<size>:<path>` (`<path>` = target **directory**)
2. await text `READY` (or `ERROR:<msg>`)
3. stream binary frames, **≤ 2048 bytes each** (hard firmware cap), draining any incoming text
   between chunks
4. await text `DONE` (or `ERROR:<msg>`)

On failure after bytes were sent, `POST /delete` the partial path, then retry with backoff.
`uploadStarted` comes back through `SidecarError.uploadStarted` so the engine knows whether cleanup
is needed.

**Pass `client.hostname` to the upload, not `client.host`** — `host` may include a non-default HTTP
port, which is not the WebSocket port. This has bitten before.

## Device identity

`stableIdentity()` in `src/device/manager.ts` scans `/api/status` for `uuid`, `serial`, `chipId`,
`mac`, … and hashes the first plausible value. Only if nothing stable exists does it fall back to an
address-derived id — in which case a single known device of the same model is reused rather than
duplicated when DHCP moves it, and the UI says the identity is address-bound. Never key device rows
on IP.
