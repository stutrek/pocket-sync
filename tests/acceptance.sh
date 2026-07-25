#!/usr/bin/env bash
# End-to-end acceptance run against the fake device (§15 of the brief).
# Nothing here touches your real library: it uses throwaway dirs under $TMP.
#
#   bash tests/acceptance.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$(mktemp -d -t pocket-acceptance)}"
DATA="$WORK/data"
DEV="$WORK/device"
API="http://127.0.0.1:8787"
VENV="${POCKET_VENV:-$HOME/Library/Application Support/pocket-sync/engine/.venv}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
jqp()  { python3 -c "import json,sys; $1"; }

cleanup() {
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
  [ -n "${DEVICE_PID:-}" ] && kill "$DEVICE_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

mkdir -p "$DATA/engine" "$DEV" "$WORK/books"
ln -sfn "$VENV" "$DATA/engine/.venv"

start_device() { # $1: extra args
  deno run -A "$ROOT/tests/fake_device.ts" --root "$DEV" --http 8199 --ws 8198 $1 \
    > "$WORK/device.log" 2>&1 &
  DEVICE_PID=$!
  sleep 2
}
stop_device() { kill "$DEVICE_PID" 2>/dev/null; wait "$DEVICE_PID" 2>/dev/null; DEVICE_PID=""; sleep 1; }

# A sync triggered while another is running is queued, so the POST can return
# before the work is done. Wait for the daemon to go idle.
wait_idle() {
  for _ in $(seq 60); do
    busy=$(curl -sS "$API/api/status" | jqp "print(json.load(sys.stdin)['syncing'])")
    [ "$busy" = "False" ] && return 0
    sleep 1
  done
}
sync_now() { wait_idle; local out; out=$(curl -sS -X POST "$API/api/devices/$DEVICE_ID/sync"); wait_idle; echo "$out"; }
device_epubs() { ls "$DEV" 2>/dev/null | grep -c '\.epub$'; }
starts() { grep -c 'START ' "$WORK/device.log"; }

step "Booting daemon and fake device ($WORK)"
start_device ""
POCKET_DATA_DIR="$DATA" deno run --allow-read --allow-write --allow-net --allow-run \
  --allow-env --allow-sys --unstable-net --unstable-raw-imports "$ROOT/src/main.ts" \
  > "$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 30); do curl -sf "$API/api/status" >/dev/null 2>&1 && break; sleep 1; done
# UDP broadcast is off: the fake device is reached through the manual host list.
curl -sS -X PUT -H 'content-type: application/json' \
  -d '{"discovery":{"enabled":false,"manualHosts":["127.0.0.1:8199"],"intervalSec":5}}' \
  "$API/api/settings" >/dev/null

step "1. Ingest: many formats become readable EPUBs"
"$VENV/bin/python3" - "$WORK/books" <<'PY'
import os, sys
from PIL import Image, ImageDraw
out = sys.argv[1]
para = ("A paragraph long enough to force the CrossPoint text splitter to do real work, "
        "repeated so the file comfortably exceeds the nine-and-a-half kilobyte split limit. ") * 12
for i, name in enumerate(["Alpha", "Bravo", "Charlie", "Delta"]):
    open(os.path.join(out, f"Test Author - {name}.txt"), "w").write(f"{name}\n\n{para}\n\n{para}")
img = Image.new("RGB", (1400, 2000), (255, 255, 255))
d = ImageDraw.Draw(img)
d.rectangle([100, 200, 1300, 1800], fill=(200, 60, 60))
d.ellipse([400, 700, 1000, 1300], fill=(40, 90, 200))
img.save(os.path.join(out, "Test Author - Echo.pdf"), "PDF", resolution=150)
PY
for f in "$WORK/books"/*; do
  curl -sS -F "file=@$f" "$API/api/books" > /dev/null
done
BOOKS=$(curl -sS "$API/api/library" | jqp "d=json.load(sys.stdin); print(len(d))")
[ "$BOOKS" = "5" ] && ok "5 books ingested (4 TXT + 1 PDF), all converted to EPUB" \
                   || bad "expected 5 books, got $BOOKS"

step "2. Device discovery and identity"
curl -sS -X POST "$API/api/devices/discover" >/dev/null
DEVICE_ID=$(curl -sS "$API/api/devices" | jqp "print(json.load(sys.stdin)[0]['id'])")
STRATEGY=$(curl -sS "$API/api/devices" | jqp "print(json.load(sys.stdin)[0]['id_strategy'])")
[ -n "$DEVICE_ID" ] && ok "device registered as $DEVICE_ID (identity from '$STRATEGY')" \
                    || bad "device not discovered"
wait_idle   # let the connect-triggered library sync finish
BASE_STARTS=$(starts)

step "3. A list of 3 books, X4 grayscale profile, add_new"
LIST=$(curl -sS -X POST -H 'content-type: application/json' -d '{"name":"Trip"}' \
  "$API/api/lists" | jqp "print(json.load(sys.stdin)['id'])")
IDS=$(curl -sS "$API/api/library" | jqp "print(' '.join(b['id'] for b in json.load(sys.stdin)))")
set -- $IDS
curl -sS -X POST -H 'content-type: application/json' -d "{\"bookIds\":[\"$1\",\"$2\",\"$3\"]}" \
  "$API/api/lists/$LIST/items" >/dev/null
PROFILE=$(curl -sS "$API/api/profiles" | jqp \
  "print([p['id'] for p in json.load(sys.stdin) if p['device_model']=='X4'][0])")
curl -sS -X PUT -H 'content-type: application/json' \
  -d "{\"source_type\":\"list\",\"source_list_id\":\"$LIST\",\"mode\":\"add_new\",\"profile_id\":\"$PROFILE\"}" \
  "$API/api/devices/$DEVICE_ID/rule" >/dev/null
rm -f "$DEV"/*.epub   # start from an empty device
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$API/api/books/$1/resend" >/dev/null
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$API/api/books/$2/resend" >/dev/null
curl -sS -X POST -H 'content-type: application/json' -d '{}' "$API/api/books/$3/resend" >/dev/null
RESULT=$(sync_now)
SENT=$(echo "$RESULT" | jqp "print(json.load(sys.stdin)['sent'])")
[ "$(device_epubs)" = "3" ] && ok "exactly 3 books on device (sent=$SENT)" \
                            || bad "expected 3 epubs on device, found $(device_epubs)"

"$VENV/bin/python3" - "$DEV" <<'PY'
import glob, io, os, re, sys, zipfile
from PIL import Image
bad = []
for path in glob.glob(os.path.join(sys.argv[1], "*.epub")):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    if names[0] != "mimetype":
        bad.append(f"{os.path.basename(path)}: mimetype not first")
    if [n for n in names if re.search(r"\.(ttf|otf|woff2?)$", n, re.I)]:
        bad.append(f"{os.path.basename(path)}: embedded fonts remain")
    for n in names:
        if n.lower().endswith((".jpg", ".jpeg", ".png")):
            im = Image.open(io.BytesIO(z.read(n)))
            if im.mode != "L":
                bad.append(f"{os.path.basename(path)}:{n} not grayscale ({im.mode})")
            if im.size[0] > 480 or im.size[1] > 800:
                bad.append(f"{os.path.basename(path)}:{n} too large {im.size}")
    for n in names:
        if n.lower().endswith((".xhtml", ".html")):
            body = z.read(n).decode("utf-8", "ignore")
            if len(body) > 12000:
                bad.append(f"{os.path.basename(path)}:{n} body {len(body)}B over split limit")
            for m in re.finditer(r"<p\b[^>]*>(.*?)</p>", body, re.S):
                if len(m.group(1)) > 1600:
                    bad.append(f"{os.path.basename(path)}:{n} paragraph {len(m.group(1))}B")
print("\n".join(bad) if bad else "CLEAN")
PY

step "4. add_new: only the newly added book transfers"
BEFORE=$(starts)
curl -sS -X POST -H 'content-type: application/json' -d "{\"bookIds\":[\"$4\"]}" \
  "$API/api/lists/$LIST/items" >/dev/null
sync_now >/dev/null
NEW=$(( $(starts) - BEFORE ))
[ "$NEW" = "1" ] && ok "one upload for the 4th book (device now has $(device_epubs))" \
                 || bad "expected 1 new upload, saw $NEW"

step "5. mirror: removing from the list deletes from the device"
curl -sS -X PUT -H 'content-type: application/json' -d '{"mode":"mirror"}' \
  "$API/api/devices/$DEVICE_ID/rule" >/dev/null
curl -sS -X DELETE -H 'content-type: application/json' -d "{\"bookIds\":[\"$1\"]}" \
  "$API/api/lists/$LIST/items" >/dev/null
RESULT=$(sync_now)
DELETED=$(echo "$RESULT" | jqp "print(json.load(sys.stdin)['deleted'])")
[ "$DELETED" = "1" ] && [ "$(device_epubs)" = "3" ] \
  && ok "stale book deleted from device (now $(device_epubs) files)" \
  || bad "expected 1 deletion and 3 files, got deleted=$DELETED files=$(device_epubs)"

step "6. connection dropped mid-transfer: no corrupt files, resumes later"
stop_device
rm -f "$DEV"/*.epub
start_device "--drop-upload 1"
for id in $1 $2 $3 $4; do
  curl -sS -X POST -H 'content-type: application/json' -d '{}' "$API/api/books/$id/resend" >/dev/null
done
curl -sS -X POST "$API/api/devices/discover" >/dev/null
sync_now >/dev/null
wait_idle
CORRUPT=$("$VENV/bin/python3" - "$DEV" <<'PY'
import glob, os, sys, zipfile
broken = []
for p in glob.glob(os.path.join(sys.argv[1], "*.epub")):
    try:
        z = zipfile.ZipFile(p)
        if z.testzip() is not None:
            broken.append(os.path.basename(p))
    except Exception:
        broken.append(os.path.basename(p))
print(len(broken))
PY
)
[ "$CORRUPT" = "0" ] && ok "no corrupt EPUBs left on device after the drop" \
                     || bad "$CORRUPT corrupt file(s) on device"

stop_device
start_device ""
curl -sS -X POST "$API/api/devices/discover" >/dev/null
sync_now >/dev/null
wait_idle
DESIRED=$(curl -sS "$API/api/library?list=$LIST" | jqp "print(len(json.load(sys.stdin)))")
[ "$(device_epubs)" = "$DESIRED" ] && ok "resumed after reconnect: $DESIRED/$DESIRED books present" \
                                   || bad "after resume expected $DESIRED files, found $(device_epubs)"

step "7. duplicate protection"
BEFORE=$(starts)
sync_now >/dev/null
[ "$(( $(starts) - BEFORE ))" = "0" ] && ok "re-syncing an up-to-date device uploads nothing" \
                                      || bad "re-sync re-uploaded books"

printf '\n\033[1m%d passed, %d failed\033[0m  (logs in %s)\n' "$pass" "$fail" "$WORK"
[ "$fail" = "0" ]
