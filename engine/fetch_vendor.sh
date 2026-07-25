#!/usr/bin/env bash
# Vendor the upstream CrossPoint modules, unmodified, pinned to a commit.
#
# We reuse three files as-is so upstream fixes can be pulled in by bumping
# PIN and re-running this script:
#   optimizer.py  — firmware-matched EPUB/image optimizer
#   textsplit.py  — paragraph/file splitting + font stripping for the low-RAM device
#   ws_client.py  — UDP discovery + WebSocket upload protocol client
#
# They are MIT licensed (CrossPoint Reader); LICENSE is vendored alongside.
set -euo pipefail

REPO="crosspoint-reader/calibre-plugins"
PIN="${CROSSPOINT_PIN:-37519a1debcb3fbd5089e0c70e05ef5817060502}"
FILES=(optimizer.py textsplit.py ws_client.py)

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/vendor/crosspoint_reader"
mkdir -p "$dest"

base="https://raw.githubusercontent.com/$REPO/$PIN"
for f in "${FILES[@]}"; do
  echo "fetching $f @ ${PIN:0:8}"
  curl -fsSL "$base/crosspoint_reader/$f" -o "$dest/$f"
done
curl -fsSL "$base/LICENSE" -o "$here/vendor/LICENSE"

# optimizer.py and textsplit.py import each other relatively, so the vendored
# files must form a package. This __init__.py is the only file we add.
cat > "$dest/__init__.py" <<EOF
"""Vendored from https://github.com/$REPO (MIT), pinned at $PIN.

Unmodified upstream sources — do not edit. Re-run engine/fetch_vendor.sh to update.
"""
EOF

cat > "$here/vendor/PINNED_AT" <<EOF
repo=$REPO
commit=$PIN
files=${FILES[*]}
fetched=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

echo "vendored ${#FILES[@]} module(s) into $dest"
