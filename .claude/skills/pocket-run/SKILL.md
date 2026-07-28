---
name: pocket-run
description: How to run, debug and change the Pocket Sync app — the required Deno flags, headless vs menu-bar mode, and the Deno Desktop pitfalls (window startup deadlock, tray menu items, port hijacking, permissions baked at compile time). Use when starting the app, editing src/main.ts or src/desktop/, or when the app hangs, won't serve, or the tray misbehaves.
---

# Running and debugging Pocket Sync

## Commands

```bash
deno task setup     # dev checkout only: venv + vendored engine (users never run this)
deno task dev       # headless daemon + web UI on 127.0.0.1:8787, --watch
deno task start     # same, no watch
deno task desktop   # runs the real menu-bar app from source (deno desktop --hmr)
deno task build     # packages the app to dist/PocketSync.app — builds only, never runs
deno task check     # type-check + lint + fmt --check — run before finishing
```

Flags are not optional. Every task carries:

```
--allow-read --allow-write --allow-net --allow-run --allow-env --allow-sys
--unstable-net --unstable-raw-imports
```

- `--unstable-net` → `Deno.listenDatagram` (UDP discovery)
- `--unstable-raw-imports` → `import … with { type: "text" | "bytes" }`, used to embed the Python
  engine and tray icons

**In a compiled app, permissions are baked at build time.** A missing `--allow-*` on `deno desktop`
shows up at runtime as `NotCapable`, not as a prompt.

## Two modes, one entrypoint

`src/main.ts` decides by checking `DENO_SERVE_ADDRESS`:

- Set (running under `deno desktop`) → first `Deno.serve` is hijacked to the runtime-chosen port
  that the startup window is pointed at; a **second** `Deno.serve` binds the configured `webPort`
  for ordinary browsers.
- Unset (`deno task start`) → single listener on `webPort`, no tray, no window.

## Deno Desktop pitfalls (each of these cost real debugging time)

1. **Never create a window or tray during top-level await.** The desktop runtime starts its native
   event loop _after_ the main module finishes evaluating. Constructing a `BrowserWindow` before
   that blocks the JS thread — the symptom is the HTTP servers accepting connections but never
   responding. `src/main.ts` defers all of it inside `setTimeout(..., 0)`. Keep it there.
2. **Every tray menu item needs `enabled`.** `setMenu` throws `missing field 'enabled'` otherwise.
   Use the `item()` helper in `src/desktop/shell.ts`.
3. **The first `new Deno.BrowserWindow()` adopts the implicit startup window**; later constructions
   open new ones. There is no `BrowserWindow.main`.
4. **`deno desktop` is hidden from `deno --help`** but exists (`deno desktop --help`). Desktop APIs
   are absent under plain `deno run` — `isDesktop()` guards this.
5. **`deno desktop` without `--hmr` only builds.** Despite the help text saying "Build and run", a
   bare `deno desktop src/main.ts` compiles a bundle into the cwd and exits 0 — nothing launches.
   `--hmr` is what actually starts the app (compiling to a cached dylib under
   `~/Library/Caches/deno/desktop/` and watching the repo), which is why `deno task desktop` carries
   it. To run an already-built bundle instead: `open "Pocket Sync.app"`, or invoke
   `Contents/MacOS/laufey_webview` directly to keep stdout.
6. **A broken shell must not take the daemon down.** Shell startup is wrapped in try/catch; keep it
   that way.
7. **The webview is WebKit, not Chromium.** Keep `src/web/ui/` and `style.css` to well-supported
   CSS/JS — no bleeding-edge APIs.
8. **The UI is built, not served from source.** `src/web/ui/*.tsx` (Preact) is bundled by
   `deno task ui` into `src/web/static/app.bundle.js`, which `server.ts` embeds as a text import.
   Every run/build task declares `ui` as a dependency, so the bundle is always fresh — but the
   import is resolved at process start, so a UI edit needs a rebuild _and_ a restart. For a tight
   loop run `deno task ui:watch` alongside `deno task dev`. The bundle is gitignored.
9. **`index.html` must load the bundle with `type="module"`.** `deno bundle` emits ESM; as a classic
   script its top-level bindings become globals, and the store's `status` signal then collides with
   the built-in `window.status`, which silently breaks the whole UI.
10. **macOS denies the desktop build all LAN access unless the bundle asks for it.** From macOS 15
    on, local network access is granted per app bundle — and an app whose `Info.plist` lacks
    `NSLocalNetworkUsageDescription` is never prompted for, never appears under Privacy & Security ›
    Local Network, and simply has its LAN traffic dropped. Both bundles `deno desktop` produces (the
    cached `laufey_webview.app` used by `--hmr`, and the app it builds) ship without that key, so
    discovery finds nothing and even a manual host cannot be probed, while the identical code under
    `deno task start` works because the terminal owns the grant. `scripts/mac_localnet.ts` adds the
    key and re-signs ad hoc; the `desktop`, `build` and `package` tasks all run it. Symptom to
    recognise: sweeps complete on schedule, no errors, nothing ever answers — surfaced in the UI as
    `discovery.silent`.

## Debugging

- Logs: stderr, `<dataDir>/logs/pocket-sync.log` (rotating JSONL), the Activity tab, and the SSE
  stream at `/api/events`. High-frequency progress goes to the bus only (`bus.emit`), not the log
  file — don't switch it to `log.*`.
- `GET /api/health?recheck=1` re-probes Calibre and the engine.
- `GET /api/books/<id>/optimized?profile=<id>` returns exactly what a device would receive — the
  fastest way to inspect optimizer changes.
- Data dir: `POCKET_DATA_DIR=/tmp/whatever` gives a throwaway library. Use it rather than polluting
  `~/Library/Application Support/pocket-sync`.
- The packaged app's executable is `<bundle>/Contents/MacOS/laufey_webview` (the webview backend
  binary); run it directly to see stdout.
- Two `laufey_webview` processes are normal; the child holds the sockets.

## External dependencies

- **Calibre is optional.** EPUB works without it; other formats need `ebook-convert`/`ebook-meta`.
  Paths auto-discover per OS (`calibreCandidates()` in `src/library/calibre.ts`); empty config means
  auto. Never make a missing Calibre fatal.
- **Python is bundled** in packaged builds and unpacked on first run. In a dev checkout
  `deno task setup` creates a venv fallback. Resolution order lives in `Sidecar.pythonPath()`:
  config → bundled → dev venv → PATH.
