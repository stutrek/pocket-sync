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

| Path           | Concern                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `src/main.ts`  | Entrypoint. Two HTTP listeners, then deferred tray/window startup                                     |
| `src/app.ts`   | Object graph + dependency probing. No GUI imports — headless-safe                                     |
| `src/core/`    | `config.ts`, `db.ts` (schema + migrations), `log.ts`, `events.ts`, `ids.ts`, `paths.ts`               |
| `src/library/` | `ingest.ts` (upload → EPUB), `calibre.ts` (CLI wrappers + discovery), `books.ts`, `lists.ts`          |
| `src/device/`  | `client.ts` (device HTTP API), `manager.ts` (discovery, registry, identity)                           |
| `src/sync/`    | `profiles.ts` (resample profiles + optimize cache), `engine.ts` (add_new / mirror)                    |
| `src/engine/`  | `sidecar.ts` (supervises Python), `runtime.ts` (bundled CPython), `assets.ts` (embedded engine files) |
| `src/web/`     | `server.ts` (REST + SSE), `static/` (no-build vanilla UI)                                             |
| `src/desktop/` | `shell.ts` (tray + window), `autostart.ts` (start at login)                                           |
| `engine/`      | `sidecar.py` (ours) + `vendor/crosspoint_reader/` (upstream, unmodified)                              |
| `tests/`       | `unit_test.ts`, `fake_device.ts`, `acceptance.sh`                                                     |

Related skills: `pocket-run` (running/debugging), `pocket-test` (verifying changes),
`pocket-device-protocol` (device + vendored engine), `pocket-package` (distributables).

## Data flow

```
upload → ingest (store original, ebook-meta, convert to book.epub)
       → SQLite row
device connects (UDP discovery or manual host) → /api/status → identity + model
       → /api/files walked → desired set from sync rule → diff
       → per book: optimize for profile (cached) → WebSocket upload ≤2048 B frames
       → device_content manifest updated → events to UI/tray
```

## Invariants — breaking these causes real bugs

1. **No GUI imports outside `src/desktop/`.** `src/app.ts` and everything under
   `core/library/device/sync/web` must run headless (`deno task start`). `src/main.ts` reaches the
   shell through a dynamic import only.
2. **Optimization is per-device-profile and lazy**, never at ingest. Cached at
   `library/<bookId>/opt-<hash>.epub`. The hash covers every setting that changes output _plus_ the
   engine version (`profileHash()` in `src/sync/profiles.ts`) — if you add a profile field that
   alters output, add it to that hash.
3. **Device identity is never the IP.** It comes from a stable `/api/status` field; the
   address-bound fallback is a last resort and is surfaced in the UI.
4. **Device filenames are `<bookId>__<title>.epub`** so on-device state can be rebuilt from a
   listing alone. The manifest is preferred, filenames are the fallback. Don't change the scheme
   without a migration.
5. **One sync per device at a time.** A trigger during a run queues exactly one rerun
   (`#running`/`#rerun` in `src/sync/engine.ts`). Sync is async — the POST can return before work
   finishes.
6. **`mirror` only deletes books Pocket Sync put there.** Files it can't attribute are left alone
   and logged. Deliberate: side-loaded books must survive.
7. **Never edit `engine/vendor/`.** See `pocket-device-protocol`.
8. **Chunk size is capped at 2048 bytes** by the firmware. The config allows less, never more.

## Testing expectations

Any change touching ingest, optimization, the device client or the sync engine should keep
`deno task acceptance` at 8/8 — it runs against a simulated reader and unpacks the delivered EPUBs
to check they are genuinely device-safe. See `pocket-test`.

## Docs

`README.md` covers install and user-facing behaviour. The original project brief is the conversation
that created the repo; §-references in comments (e.g. "§8.2") point at that brief's numbered
sections, preserved in the code comments themselves.
