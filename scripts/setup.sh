#!/usr/bin/env bash
# Developer setup. End users do not need this: the packaged app ships its own
# Python runtime (see scripts/fetch_python.ts) and unpacks it on first run.
# This only prepares a local checkout for `deno task dev`.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "Xteink Sync setup"
echo

echo "Runtime:"
if command -v deno >/dev/null 2>&1; then
  ok "deno $(deno --version | head -1 | awk '{print $2}')"
  if ! deno desktop --help >/dev/null 2>&1; then
    warn "this deno build has no 'desktop' subcommand — headless mode only (deno task start)"
  fi
else
  fail "deno not found — install from https://deno.com (2.9+ needed for the desktop build)"
  exit 1
fi

echo
echo "Calibre CLI:"
convert_path="${CALIBRE_CONVERT:-/Applications/calibre.app/Contents/MacOS/ebook-convert}"
meta_path="${CALIBRE_META:-/Applications/calibre.app/Contents/MacOS/ebook-meta}"
for p in "$convert_path" "$meta_path"; do
  if [ -x "$p" ]; then ok "$(basename "$p") at $p"
  else fail "$(basename "$p") missing at $p — install Calibre or set the path in Settings"; fi
done

echo
echo "Engine (vendored CrossPoint modules):"
if [ ! -f engine/vendor/crosspoint_reader/optimizer.py ]; then
  bash engine/fetch_vendor.sh
fi
ok "pinned at $(sed -n 's/^commit=//p' engine/vendor/PINNED_AT | cut -c1-8)"

echo
echo "Python sidecar:"
# The venv lives in the data dir, not the repo, so a packaged .app finds the
# same interpreter the dev build uses.
data_dir="${XTEINK_DATA_DIR:-$HOME/Library/Application Support/xteink-sync}"
venv="$data_dir/engine/.venv"
py="${PYTHON:-python3}"
if ! command -v "$py" >/dev/null 2>&1; then
  fail "python3 not found"
  exit 1
fi
mkdir -p "$data_dir/engine"
if [ ! -x "$venv/bin/python3" ]; then
  "$py" -m venv "$venv"
  ok "created $venv"
fi
"$venv/bin/python3" -m pip install --quiet --upgrade pip >/dev/null
"$venv/bin/python3" -m pip install --quiet -r engine/requirements.txt
ok "installed $("$venv/bin/python3" -c 'import PIL, lxml.etree; print("Pillow " + PIL.__version__ + ", lxml " + lxml.etree.__version__)')"

echo
echo "Sidecar self-test:"
if printf '{"id":1,"cmd":"ping"}\n' | "$venv/bin/python3" engine/sidecar.py | grep -q '"vendor": true'; then
  ok "sidecar imports the vendored optimizer"
else
  fail "sidecar ping failed — run: engine/.venv/bin/python3 engine/sidecar.py"
  exit 1
fi

echo
echo "Done. Next:"
echo "  deno task dev         # headless daemon + web UI on http://127.0.0.1:8787"
echo "  deno task desktop     # menu-bar app (builds and runs)"
echo "  deno task package     # distributable for this platform"
echo "  deno task package --all   # macOS, Windows and Linux artifacts"
