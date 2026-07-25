---
name: pocket-package
description: Build the double-clickable distributables (macOS .dmg, Windows .msi, Linux .AppImage) including the bundled Python runtime, and the constraints around signing, sizes and cross-compiling. Use when producing a release, changing scripts/package.ts or scripts/fetch_python.ts, or when an artifact fails to build or won't launch.
---

# Packaging

```bash
deno task package          # this platform
deno task package --all    # every target, from one host
deno task python --all     # just rebuild the Python runtime archives
```

Artifacts land in `dist/` — nothing else, the intermediate app dirs are cleaned up:

| Target                      | Artifact                          | ~Size |
| --------------------------- | --------------------------------- | ----- |
| `aarch64-apple-darwin`      | `PocketSync-macos-arm64.dmg`      | 64 MB |
| `x86_64-apple-darwin`       | `PocketSync-macos-x64.dmg`        | 66 MB |
| `x86_64-pc-windows-msvc`    | `PocketSync-windows-x64.msi`      | 54 MB |
| `x86_64-unknown-linux-gnu`  | `PocketSync-linux-x64.AppImage`   | 75 MB |
| `aarch64-unknown-linux-gnu` | `PocketSync-linux-arm64.AppImage` | 69 MB |

`deno desktop` picks the format from the `--output` extension and fetches prebuilt runtimes per
target, so **all five build from one macOS or Linux host** — no platform toolchain needed.
`scripts/package.ts` falls back to the plain app directory if an installer format needs unavailable
host tooling, and says so.

## Why there is no "setup step"

The resampler needs Pillow and lxml. Rather than requiring the user to install Python,
`scripts/fetch_python.ts` downloads a stripped
[python-build-standalone](https://github.com/astral-sh/python-build-standalone) CPython for the
target, installs Pillow + lxml **wheels for that platform** into it
(`pip install --target … --platform <tag> --only-binary=:all:`), prunes it, and tars it to
`build/python-<target>.tar.gz` (~23–40 MB).

`scripts/package.ts` copies the right one to the fixed path `build/python-runtime.tar.gz` and embeds
it with `deno desktop --include`. `src/engine/runtime.ts` streams it out of the embedded VFS on
first run (`Deno.open(new URL(…, import.meta.url))` → gzip → `@std/tar`), preserving the executable
bit, into `<dataDir>/engine/python`. Bump `BUNDLE_VERSION` there when the archive changes — that
stamp is what triggers re-extraction.

Hard-won details:

- Use the **`install_only_stripped`** CPython assets. The unstripped Linux `libpython3.12.so`
  carries 209 MB of debug symbols.
- Prune `.a`, `.pdb`, `config-3.12-*`, tcl/tk, `test`, `idlelib`, `__pycache__`.
- Extraction must be **pure Deno** — do not shell out to `tar`; a user's machine may not have it,
  and Windows behaviour differs.
- `hdiutil` refuses to overwrite an existing `.dmg`, so the output path is removed before each
  build.
- Skip `aarch64-pc-windows-msvc`: Pillow/lxml wheels for `win_arm64` aren't dependable, and
  Windows-on-ARM runs the x64 build.

## Signing and first launch

Builds are **ad-hoc signed only** (no paid certificate), so the OS warns:

- macOS: right-click → _Open_, or `xattr -dr com.apple.quarantine <app>`
- Windows: SmartScreen → _More info_ → _Run anyway_

Real distribution needs a Developer ID plus `xcrun notarytool submit` on macOS, and an external
signing step for the Windows executables. Not done.

## Verifying an artifact

The macOS build has been run end-to-end from a clean data dir with `env -i` and `PATH=/usr/bin:/bin`
(proving nothing on the host is used):

```
runtime.ready — Python runtime ready (~1500 files in ~1s)
deps.engine   — Resampling engine ready (Python 3.12.13, bundled)
tray.ready    — Menu-bar icon ready
```

**The Windows and Linux artifacts have never been launched** — only checked with `file` (correct ELF
arch / MSI container). Their bundled interpreters and the platform webview backends are untested;
Linux needs system WebKitGTK present. Launch each on a real machine before treating a release as
shippable.
