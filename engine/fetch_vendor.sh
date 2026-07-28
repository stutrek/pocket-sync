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

# Currently a fork, not the upstream repo. It is upstream plus two fixes we hit
# in practice and could not carry ourselves, because these files are vendored
# verbatim and never patched locally:
#
#   * images are encoded as JPEG *or* PNG, whichever is smaller. The firmware
#     decodes both (ImageDecoderFactory.cpp), and forcing JPEG inflated flat
#     2-colour artwork ~6x — a 492 KB book came out at 778 KB — while also
#     putting ringing artifacts around the very line art it damages most.
#   * named HTML entities are replaced with numeric ones. The lxml round-trip
#     drops the DOCTYPE, and without a DTD a surviving `&nbsp;` is a fatal
#     undefined-entity error on-device.
#
# Both belong upstream; point REPO back at crosspoint-reader once they land
# there, which is the whole reason this is an override rather than an edit.
REPO="${CROSSPOINT_REPO:-stutrek/calibre-plugins}"
PIN="${CROSSPOINT_PIN:-22efe5e5c29e77febf85c11d4c250943682cc026}"
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
