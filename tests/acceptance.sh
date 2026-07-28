#!/usr/bin/env bash
# End-to-end acceptance run against the fake device.
#
# Exercises the model in docs/DESIGN.md: a watched folder is the library, book
# identity is the MD5 of the file, and a book that leaves the folder leaves the
# device — with rails so an unreadable folder never clears a reader.
#
# Nothing here touches your real library: it uses throwaway dirs under $TMP.
#
#   bash tests/acceptance.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$(mktemp -d -t pocket-acceptance)}"
DATA="$WORK/data"
DEV="$WORK/device"
BOOKROOT="$WORK/root"        # the one folder everything lives under
SHELF="$BOOKROOT/shelf"      # a watched folder inside it
PORT="${PORT:-8899}"
API="http://127.0.0.1:$PORT"
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

mkdir -p "$DATA/engine" "$DEV" "$SHELF"
ln -sfn "$VENV" "$DATA/engine/.venv"
# Bind our own port before boot: colliding with a running `deno task dev` would
# aim every request in this script at the developer's real library.
# The kosync listener gets its own non-default port for the same reason.
cat > "$DATA/config.json" <<JSON
{ "webPort": $PORT, "webHost": "127.0.0.1",
  "kosync": { "enabled": true, "port": 8898, "host": "127.0.0.1" } }
JSON

start_device() { # $1: extra args
  deno run -A "$ROOT/tests/fake_device.ts" --root "$DEV" --http 8199 --ws 8198 $1 \
    > "$WORK/device.log" 2>&1 &
  DEVICE_PID=$!
  sleep 2
}
stop_device() { kill "$DEVICE_PID" 2>/dev/null; wait "$DEVICE_PID" 2>/dev/null; DEVICE_PID=""; sleep 1; }

start_daemon() {
  POCKET_DATA_DIR="$DATA" deno run --allow-read --allow-write --allow-net --allow-run \
    --allow-env --allow-sys --unstable-net --unstable-raw-imports "$ROOT/src/main.ts" \
    >> "$WORK/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 30); do curl -sf "$API/api/status" >/dev/null 2>&1 && break; sleep 1; done
}
# Config is read at startup, so anything hand-written into config.json — an
# external source, for instance — needs a restart to take effect.
restart_daemon() {
  kill "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null
  sleep 1
  start_daemon
}

# A sync triggered while another is running is queued, so the POST can return
# before the work is done. Wait for the daemon to go idle.
wait_idle() {
  for _ in $(seq 60); do
    busy=$(curl -sS "$API/api/status" | jqp "print(json.load(sys.stdin)['syncing'])")
    [ "$busy" = "False" ] && return 0
    sleep 1
  done
}
rescan() { curl -sS -X POST "$API/api/libraries/$LIB/scan" >/dev/null; }
sync_now() {
  wait_idle
  local out; out=$(curl -sS -X POST "$API/api/devices/$DEVICE_ID/sync?confirmRemovals=1")
  wait_idle
  echo "$out"
}
device_epubs() { ls "$DEV" 2>/dev/null | grep -c '\.epub$'; }
starts() { grep -c 'START ' "$WORK/device.log"; }
book_count() { curl -sS "$API/api/library" | jqp "print(len(json.load(sys.stdin)))"; }

step "Booting daemon and fake device ($WORK)"
start_device ""
POCKET_DATA_DIR="$DATA" deno run --allow-read --allow-write --allow-net --allow-run \
  --allow-env --allow-sys --unstable-net --unstable-raw-imports "$ROOT/src/main.ts" \
  > "$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 30); do curl -sf "$API/api/status" >/dev/null 2>&1 && break; sleep 1; done
if grep -q "web.listen.failed" "$WORK/daemon.log" 2>/dev/null; then
  printf '\033[31mPort %s is already in use — aborting so we do not talk to another instance.\033[0m\n' "$PORT"
  exit 1
fi
# UDP broadcast is off: the fake device is reached through the manual host list.
curl -sS -X PUT -H 'content-type: application/json' \
  -d '{"discovery":{"enabled":false,"manualHosts":["127.0.0.1:8199"],"intervalSec":5},"scan":{"settleSec":0}}' \
  "$API/api/settings" >/dev/null

step "1. A watched folder becomes the library"
"$VENV/bin/python3" - "$SHELF" <<'PY'
import os, sys
from PIL import Image, ImageDraw
out = sys.argv[1]
para = ("A paragraph long enough to force the CrossPoint text splitter to do real work, "
        "repeated so the file comfortably exceeds the nine-and-a-half kilobyte split limit. ") * 12
for name in ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]:
    open(os.path.join(out, f"Test Author - {name}.txt"), "w").write(f"{name}\n\n{para}\n\n{para}")
img = Image.new("RGB", (1400, 2000), (255, 255, 255))
d = ImageDraw.Draw(img)
d.rectangle([100, 200, 1300, 1800], fill=(200, 60, 60))
d.ellipse([400, 700, 1000, 1300], fill=(40, 90, 200))
img.save(os.path.join(out, "Test Author - Golf.pdf"), "PDF", resolution=150)
PY
curl -sS -X POST -H 'content-type: application/json' -d "{\"path\":\"$BOOKROOT\"}" \
  "$API/api/root" >/dev/null
LIB=$(curl -sS -X POST -H 'content-type: application/json' -d '{"name":"Shelf","relPath":"shelf"}' \
  "$API/api/libraries" | jqp "print(json.load(sys.stdin)['id'])")
rescan
[ "$(book_count)" = "7" ] && ok "7 books indexed from the folder (6 TXT + 1 PDF)" \
                          || bad "expected 7 books, got $(book_count)"

step "2. Identity follows content, not the filename"
FIRST_ID=$(curl -sS "$API/api/library" | jqp \
  "print(sorted(b['id'] for b in json.load(sys.stdin))[0])")
mv "$SHELF/Test Author - Alpha.txt" "$SHELF/Renamed Entirely.txt"
rescan
STILL=$(curl -sS "$API/api/library" | jqp \
  "print(sorted(b['id'] for b in json.load(sys.stdin))[0])")
[ "$(book_count)" = "7" ] && [ "$FIRST_ID" = "$STILL" ] \
  && ok "renaming a file did not duplicate or re-identify the book" \
  || bad "rename changed the library: count=$(book_count) id=$STILL (was $FIRST_ID)"

# Identity is the content hash, so a second copy is the same book, not a new one.
cp "$SHELF/Test Author - Bravo.txt" "$SHELF/A Duplicate Copy.txt"
rescan
[ "$(book_count)" = "7" ] && ok "an identical copy deduplicates instead of adding a book" \
                          || bad "duplicate copy created a new book: $(book_count)"
rm -f "$SHELF/A Duplicate Copy.txt"
rescan

step "3. Device discovery and folder binding"
curl -sS -X POST "$API/api/devices/discover" >/dev/null
DEVICE_ID=$(curl -sS "$API/api/devices" | jqp "print(json.load(sys.stdin)[0]['id'])")
STRATEGY=$(curl -sS "$API/api/devices" | jqp "print(json.load(sys.stdin)[0]['id_strategy'])")
[ -n "$DEVICE_ID" ] && ok "device registered as $DEVICE_ID (identity from '$STRATEGY')" \
                    || bad "device not discovered"
curl -sS -X PUT -H 'content-type: application/json' -d "{\"deviceIds\":[\"$DEVICE_ID\"]}" \
  "$API/api/libraries/$LIB" >/dev/null
# Resampling should already match the hardware without being asked.
AUTOPROF=$(curl -sS "$API/api/devices" | jqp \
  "d=json.load(sys.stdin)[0]; print(d['settings']['profile_id'] or '')")
PROFNAME=$(curl -sS "$API/api/profiles" | jqp \
  "print(next((p['name'] for p in json.load(sys.stdin) if p['id']=='$AUTOPROF'), 'none'))")
[ "$PROFNAME" = "X4 default" ] && ok "resampling defaulted to the device model ($PROFNAME)" \
                               || bad "expected the X4 profile by default, got '$PROFNAME'"
wait_idle
rm -f "$DEV"/*.epub
curl -sS "$API/api/library" | jqp \
  "print('\n'.join(b['id'] for b in json.load(sys.stdin)))" > "$WORK/ids"
while read -r id; do
  curl -sS -X POST "$API/api/books/$id/resend" >/dev/null
done < "$WORK/ids"

step "4. Everything in the folder syncs, with human-readable names"
RESULT=$(sync_now)
SENT=$(echo "$RESULT" | jqp "print(json.load(sys.stdin)['sent'])")
[ "$(device_epubs)" = "7" ] && ok "all 7 books on device (sent=$SENT)" \
                            || bad "expected 7 epubs on device, found $(device_epubs)"
if ls "$DEV" | grep -qE '^[0-9a-f]{32}\.epub$'; then
  bad "device filenames are still hashes, not titles"
else
  ok "device filenames are readable ($(ls "$DEV" | head -1))"
fi

step "5. Delivered EPUBs are genuinely device-safe"
CLEAN=$("$VENV/bin/python3" - "$DEV" <<'PY'
import glob, io, os, re, sys, zipfile
from PIL import Image
bad = []
stamped = 0
for path in glob.glob(os.path.join(sys.argv[1], "*.epub")):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    if names[0] != "mimetype":
        bad.append(f"{os.path.basename(path)}: mimetype not first")
    if [n for n in names if re.search(r"\.(ttf|otf|woff2?)$", n, re.I)]:
        bad.append(f"{os.path.basename(path)}: embedded fonts remain")
    for n in names:
        if n.lower().endswith(".opf") and b"pocketsync-source-md5" in z.read(n):
            stamped += 1
        if n.lower().endswith((".jpg", ".jpeg", ".png")):
            im = Image.open(io.BytesIO(z.read(n)))
            # "L" is a grayscale raster. "P" is indexed colour, which the
            # optimizer emits when a small palette beats JPEG on size — safe
            # only if every palette entry is itself gray, so check the palette
            # rather than trusting the mode. Anything else is colour reaching a
            # monochrome screen.
            if im.mode == "P":
                pal = im.getpalette() or []
                triples = [tuple(pal[i:i + 3]) for i in range(0, len(pal), 3)]
                offenders = [t for t in triples if len(set(t)) > 1]
                if offenders:
                    bad.append(
                        f"{os.path.basename(path)}:{n} palette is not gray ({offenders[:3]})")
            elif im.mode != "L":
                bad.append(f"{os.path.basename(path)}:{n} not grayscale ({im.mode})")
            if not n.lower().endswith(".png") and im.format == "PNG":
                bad.append(f"{os.path.basename(path)}:{n} is a PNG with the wrong extension")
            if im.size[0] > 480 or im.size[1] > 800:
                bad.append(f"{os.path.basename(path)}:{n} too large {im.size}")
        if n.lower().endswith((".xhtml", ".html")):
            body = z.read(n).decode("utf-8", "ignore")
            if len(body) > 12000:
                bad.append(f"{os.path.basename(path)}:{n} body {len(body)}B over split limit")
            for m in re.finditer(r"<p\b[^>]*>(.*?)</p>", body, re.S):
                if len(m.group(1)) > 1600:
                    bad.append(f"{os.path.basename(path)}:{n} paragraph {len(m.group(1))}B")
if not stamped:
    bad.append("no delivered EPUB carries the source-md5 stamp")
print("\n".join(bad) if bad else "CLEAN")
PY
)
[ "$CLEAN" = "CLEAN" ] && ok "grayscale, ≤480×800, font-free, split, and stamped with the source hash" \
                       || bad "device-safety check failed:
$CLEAN"

step "6. A new file in the folder syncs; nothing else moves"
BEFORE=$(starts)
printf 'Hotel\n\nA genuinely different book, so its content hash is new.\n%s\n' \
  "$(head -c 2000 "$SHELF/Test Author - Bravo.txt")" > "$SHELF/Test Author - Hotel.txt"
rescan
sync_now >/dev/null
NEW=$(( $(starts) - BEFORE ))
[ "$NEW" = "1" ] && ok "one upload for the new file (device now has $(device_epubs))" \
                 || bad "expected 1 new upload, saw $NEW"

step "7. Removing a file from the folder removes it from the device"
rm -f "$SHELF/Test Author - Hotel.txt"
rescan
RESULT=$(sync_now)
DELETED=$(echo "$RESULT" | jqp "print(json.load(sys.stdin)['deleted'])")
[ "$DELETED" = "1" ] && [ "$(device_epubs)" = "7" ] \
  && ok "the removed book was deleted from the device (now $(device_epubs) files)" \
  || bad "expected 1 deletion and 7 files, got deleted=$DELETED files=$(device_epubs)"

step "8. An unreadable folder never clears the device"
mv "$SHELF" "$WORK/shelf.away"
RESULT=$(curl -sS -X POST "$API/api/devices/$DEVICE_ID/sync?confirmRemovals=1")
wait_idle
SKIPPED=$(echo "$RESULT" | jqp "print(json.load(sys.stdin).get('skipped',''))")
[ "$(device_epubs)" = "7" ] && [ "$SKIPPED" = "folder unavailable" ] \
  && ok "sync aborted on a missing folder, all 7 books still on device" \
  || bad "expected an aborted sync with books intact, got skipped='$SKIPPED' files=$(device_epubs)"
mv "$WORK/shelf.away" "$SHELF"
rescan

step "9. Bulk removals stop and ask before deleting"
mkdir -p "$WORK/stash"
mv "$SHELF"/*.txt "$WORK/stash/"
rescan
RESULT=$(curl -sS -X POST "$API/api/devices/$DEVICE_ID/sync")
wait_idle
PENDING=$(echo "$RESULT" | jqp "print(len(json.load(sys.stdin).get('pendingRemovals') or []))")
[ "$(device_epubs)" = "7" ] && [ "$PENDING" -gt 5 ] \
  && ok "$PENDING removals held for confirmation, nothing deleted yet" \
  || bad "expected a confirmation prompt, got pending=$PENDING files=$(device_epubs)"
RESULT=$(sync_now)
DELETED=$(echo "$RESULT" | jqp "print(json.load(sys.stdin)['deleted'])")
[ "$DELETED" -gt 0 ] && ok "confirming removed $DELETED book(s) (device now has $(device_epubs))" \
                     || bad "confirmed sync deleted nothing"
mv "$WORK/stash"/*.txt "$SHELF/"
rescan

step "10. Paths outside the root are refused over HTTP"
mkdir -p "$WORK/outside"
REFUSED=0
for ATTEMPT in '{"relPath":"../outside"}' '{"relPath":"/etc"}' '{"relPath":"shelf/../../outside"}'; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "$ATTEMPT" "$API/api/libraries")
  [ "$CODE" = "400" ] && REFUSED=$((REFUSED+1)) || echo "    accepted $ATTEMPT (HTTP $CODE)"
done
[ "$REFUSED" = "3" ] && ok "traversal and absolute paths all rejected" \
                     || bad "only $REFUSED/3 escape attempts were rejected"
# A symlink inside the root pointing out of it must not be a way through.
ln -sfn "$WORK/outside" "$BOOKROOT/escape"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"relPath":"escape"}' "$API/api/libraries")
[ "$CODE" = "400" ] && ok "a symlink out of the root is rejected" \
                    || bad "symlink escape accepted (HTTP $CODE)"
rm -f "$BOOKROOT/escape"
BROWSE=$(curl -sS "$API/api/root/browse?rel=.." | jqp "print('error' in json.load(sys.stdin))")
[ "$BROWSE" = "True" ] && ok "browsing above the root is rejected" \
                       || bad "browse escaped the root"

step "11. A device syncs several folders at once"
SHELF2="$BOOKROOT/shelf2"
mkdir -p "$SHELF2"
"$VENV/bin/python3" - "$SHELF2" <<'MAKE2'
import os, sys
para = ("Second shelf filler, long enough to exercise the splitter properly. ") * 20
for name in ["Zulu", "Yankee"]:
    open(os.path.join(sys.argv[1], f"Other Author - {name}.txt"), "w").write(f"{name}\n\n{para}")
MAKE2
LIB2=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"name":"Second","relPath":"shelf2"}' "$API/api/libraries" \
  | jqp "print(json.load(sys.stdin)['id'])")
curl -sS -X POST "$API/api/libraries/$LIB2/scan" >/dev/null
curl -sS -X PUT -H 'content-type: application/json' -d "{\"deviceIds\":[\"$DEVICE_ID\"]}" \
  "$API/api/libraries/$LIB2" >/dev/null
FOLDERS=$(curl -sS "$API/api/devices" | jqp "print(len(json.load(sys.stdin)[0]['plan']['folders']))")
[ "$FOLDERS" = "2" ] && ok "the device is bound to both folders" \
                     || bad "expected 2 folders bound, got $FOLDERS"
sync_now >/dev/null
[ "$(device_epubs)" = "9" ] && ok "union of both folders on device (7 + 2 = 9)" \
                            || bad "expected 9 epubs from two folders, found $(device_epubs)"

# Binding a second folder must not have unbound the first.
STILL=$(curl -sS "$API/api/libraries" | jqp \
  "print(sum(1 for l in json.load(sys.stdin) if '$DEVICE_ID' in l['deviceIds']))")
[ "$STILL" = "2" ] && ok "binding one folder did not unbind the other" \
                   || bad "expected the device in 2 folders, found $STILL"

step "12. One unavailable folder aborts the whole sync"
mv "$SHELF2" "$WORK/shelf2.away"
RESULT=$(curl -sS -X POST "$API/api/devices/$DEVICE_ID/sync?confirmRemovals=1")
wait_idle
SKIPPED=$(echo "$RESULT" | jqp "print(json.load(sys.stdin).get('skipped',''))")
[ "$(device_epubs)" = "9" ] && [ "$SKIPPED" = "folder unavailable" ] \
  && ok "one missing folder aborted the sync; all 9 books intact" \
  || bad "expected an abort with books intact, got skipped='$SKIPPED' files=$(device_epubs)"
mv "$WORK/shelf2.away" "$SHELF2"
curl -sS -X DELETE "$API/api/libraries/$LIB2" >/dev/null
rescan

step "13. Removing a folder mid-import stops the work and leaves no orphans"
BIG="$BOOKROOT/big"
mkdir -p "$BIG"
"$VENV/bin/python3" - "$BIG" <<'MAKEBULK'
import os, sys
out = sys.argv[1]
para = ("Filler text repeated enough that converting each of these takes real time, "
        "so the folder can be removed while the import is still running. ") * 14
for i in range(12):
    open(os.path.join(out, f"Bulk Author - Book {i:02d}.txt"), "w").write(f"Book {i}\n\n{para}")
MAKEBULK
BIGLIB=$(curl -sS -X POST -H 'content-type: application/json' \
  -d '{"name":"Too Much","relPath":"big"}' "$API/api/libraries" \
  | jqp "print(json.load(sys.stdin)['id'])")
# Don't wait for the scan: remove the folder while it is still importing.
curl -sS -X POST "$API/api/libraries/$BIGLIB/scan" >/dev/null 2>&1 &
SCAN_PID=$!
sleep 5
curl -sS -X DELETE "$API/api/libraries/$BIGLIB" >/dev/null
wait "$SCAN_PID" 2>/dev/null
sleep 8
ORPHANS=$(curl -sS "$API/api/library" | jqp \
  "print(sum(1 for b in json.load(sys.stdin) if b['library_id'] == '$BIGLIB'))")
GONE=$(curl -sS "$API/api/libraries" | jqp \
  "print(sum(1 for l in json.load(sys.stdin) if l['id'] == '$BIGLIB'))")
[ "$ORPHANS" = "0" ] && [ "$GONE" = "0" ] \
  && ok "removal stopped the import and left no rows behind" \
  || bad "after removal: $ORPHANS orphan book row(s), $GONE library row(s)"
[ "$(book_count)" = "7" ] && ok "the other folder is untouched (7 books)" \
                          || bad "other folder disturbed: $(book_count) books"

step "14. Connection dropped mid-transfer: no corrupt files, resumes later"
sync_now >/dev/null   # drop the second folder's books now that it is unbound
stop_device
rm -f "$DEV"/*.epub
start_device "--drop-upload 1"
curl -sS "$API/api/library" | jqp "print('\n'.join(b['id'] for b in json.load(sys.stdin)))" \
  > "$WORK/ids"
while read -r id; do curl -sS -X POST "$API/api/books/$id/resend" >/dev/null; done < "$WORK/ids"
curl -sS -X POST "$API/api/devices/discover" >/dev/null
sync_now >/dev/null
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
DESIRED=$(book_count)
[ "$(device_epubs)" = "$DESIRED" ] && ok "resumed after reconnect: $DESIRED/$DESIRED books present" \
                                   || bad "after resume expected $DESIRED files, found $(device_epubs)"

step "15. Reader keys are validated and never leave this machine"
# The harness assumes no Calibre, so this covers what is Calibre-independent:
# validation, and that key material is loopback-only.
REJECTED=0
for BADSERIAL in '{"serial":""}' '{"serial":"B0023456"}' '{"serial":"B00234567890123!"}' '{}'; do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
    -d "$BADSERIAL" "$API/api/calibre/keys/serial")
  [ "$CODE" = "400" ] && REJECTED=$((REJECTED+1)) || echo "    accepted $BADSERIAL (HTTP $CODE)"
done
[ "$REJECTED" = "4" ] && ok "malformed serials are all rejected before touching Calibre" \
                      || bad "only $REJECTED/4 malformed serials were rejected"
# A serial decrypts someone's purchases, so it must never be readable remotely.
# The listener is on 127.0.0.1, so reaching it as a non-local caller is only
# possible via a forwarded Host; assert instead that the route reports its own
# locality rather than leaking a key list unconditionally.
KEYS=$(curl -sS "$API/api/calibre/keys" | jqp "d=json.load(sys.stdin); print(d.get('local'), 'serials' in d)")
[ "$KEYS" = "True True" ] && ok "the key endpoint answers a local caller with a serial list" \
                          || bad "unexpected key endpoint shape: $KEYS"
# Nothing about a key may reach the un-gated settings payload.
LEAK=$(curl -sS "$API/api/settings" | jqp "print('serial' in sys.stdin.read().lower())" 2>/dev/null \
  || curl -sS "$API/api/settings" | grep -ci serial)
[ "$LEAK" = "False" ] || [ "$LEAK" = "0" ] && ok "no key material appears in /api/settings" \
                                           || bad "settings payload mentions serials"

step "16. A read-only source is never written to or deleted from"
# External sources (a Calibre library, Kindle's content folder) are the one
# exception to "nothing is watched outside the library root". That is safe only
# because they are read-only, so this step proves the enforcement rather than
# trusting it. The source is faked by marking a library readOnly in config.
EXT="$WORK/external"
mkdir -p "$EXT"
# Distinct content, so these books exist *only* in the read-only source and the
# delete path cannot be satisfied by some other copy.
python3 - "$EXT" <<'PY'
import os, sys
para = ("Content unique to the read-only source, long enough to import cleanly. ") * 20
for name in ["Hotel", "India"]:
    open(os.path.join(sys.argv[1], f"Test Author - {name}.txt"), "w").write(f"{name}\n\n{para}")
PY
EXT_BOOK=$(ls "$EXT" | head -1)
python3 - "$DATA/config.json" "$EXT" <<'PY'
import json, sys, uuid
cfg = json.load(open(sys.argv[1]))
cfg["libraries"].append({
    "id": "extsrc", "name": "Fake Calibre", "path": sys.argv[2],
    "deviceIds": [], "external": True, "readOnly": True, "sourceId": "calibre",
})
json.dump(cfg, open(sys.argv[1], "w"))
PY
restart_daemon
# Scan the source itself, and wait for the conversions it kicks off.
curl -sS -X POST "$API/api/libraries/extsrc/scan" >/dev/null
for _ in $(seq 60); do
  PENDING=$(curl -sS "$API/api/inbox" | jqp \
    "print(sum(1 for j in json.load(sys.stdin) if j['state'] == 'running'))")
  [ "$PENDING" = "0" ] && break
  sleep 1
done
wait_idle

# Find a book that exists ONLY in the read-only source.
EXT_ID=$(curl -sS "$API/api/library?library=extsrc" | jqp "
import json,sys
books=json.load(sys.stdin)
print(books[0]['id'] if books else '')")
if [ -n "$EXT_ID" ]; then
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/api/books/$EXT_ID")
  # The status code is not the point; the file surviving is.
  if [ "$CODE" = "403" ] && [ -f "$EXT/$EXT_BOOK" ]; then
    ok "deleting a book in a read-only source is refused and the file survives"
  else
    bad "read-only delete: HTTP $CODE, file present=$([ -f "$EXT/$EXT_BOOK" ] && echo yes || echo no)"
  fi
  # Uploading into one must be refused too.
  UP=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -F "file=@$EXT/$EXT_BOOK" \
    "$API/api/books?library=extsrc")
  [ "$UP" = "403" ] && ok "uploading into a read-only source is refused" \
                    || bad "upload into read-only source returned HTTP $UP"
else
  bad "the external source indexed no books"
fi

# Un-watching a source must remove the rows and leave every file alone.
BEFORE_FILES=$(ls "$EXT" | wc -l | tr -d ' ')
curl -sS -X DELETE "$API/api/libraries/extsrc" >/dev/null
AFTER_FILES=$(ls "$EXT" | wc -l | tr -d ' ')
[ "$BEFORE_FILES" = "$AFTER_FILES" ] && ok "un-watching a source deletes no files ($AFTER_FILES intact)" \
                                     || bad "un-watching removed files: $BEFORE_FILES -> $AFTER_FILES"

# The allowlist is the only route to an external library: no request body can
# create one, and unknown source ids are refused outright.
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"name":"Sneaky","relPath":"shelf","external":true,"readOnly":false}' "$API/api/libraries")
INJECTED=$(curl -sS "$API/api/libraries" | jqp "
import json,sys
print(any(l.get('external') for l in json.load(sys.stdin)))")
[ "$INJECTED" = "False" ] && ok "the external flag cannot be set through /api/libraries (HTTP $CODE)" \
                          || bad "a request body created an external library"
BOGUS=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/api/sources/..%2F..%2Fetc/enable")
[ "$BOGUS" = "404" ] && ok "an unknown source id is refused" \
                     || bad "unknown source id returned HTTP $BOGUS"

step "17. Duplicate protection"
BEFORE=$(starts)
sync_now >/dev/null
[ "$(( $(starts) - BEFORE ))" = "0" ] && ok "re-syncing an up-to-date device uploads nothing" \
                                      || bad "re-sync re-uploaded books"

step "18. The reader is told where to report reading progress"
# Nobody is holding it yet, so there are no credentials to give it.
UNSET=$(curl -sS "$API/api/devices" | jqp \
  "print(json.load(sys.stdin)[0]['settings']['kosync_state'] or 'none')")
[ "$UNSET" = "skipped" ] && ok "a reader nobody holds is left unconfigured ($UNSET)" \
                         || bad "expected page sync to be skipped, got '$UNSET'"
USER_ID=$(curl -sS -X POST -H 'content-type: application/json' -d '{"name":"Acceptance"}' \
  "$API/api/users" | jqp "print(json.load(sys.stdin)['id'])")
curl -sS -X PUT -H 'content-type: application/json' -d "{\"user_id\":\"$USER_ID\"}" \
  "$API/api/devices/$DEVICE_ID/settings" >/dev/null
sync_now >/dev/null
MATCH=$(curl -sS "$API/api/kosync" | python3 -c "
import json, sys
want = json.load(sys.stdin)
me = next(u for u in want['users'] if u['userId'] == '$USER_ID')
got = json.load(open('$WORK/device.settings.json'))
print(got.get('koServerUrl') == want['url']
      and got.get('koUsername') == me['username']
      and got.get('koPassword') == me['password']
      and got.get('koMatchMethod') == 1)
")
[ "$MATCH" = "True" ] && ok "the reader now points at our sync server, matching on content" \
                      || bad "reader settings do not match: $(cat "$WORK/device.settings.json")"

# Written once and then left alone: the fingerprint of what it accepted has to
# spare the next sync the round trip.
BEFORE=$(grep -c 'settings {' "$WORK/device.log")
sync_now >/dev/null
[ "$(grep -c 'settings {' "$WORK/device.log")" = "$BEFORE" ] \
  && ok "an already-configured reader is not written to again" \
  || bad "page-sync settings were pushed a second time"

step "19. A reader already pointed elsewhere is adopted, not overwritten"
# Somebody set this reader up by hand against their own sync server before
# Pocket Sync ever saw it. Handing it to a new person is what clears the
# fingerprint, so the next attempt actually looks at what the reader holds.
OTHER=$(curl -sS -X POST -H 'content-type: application/json' -d '{"name":"Bo"}' \
  "$API/api/users" | jqp "print(json.load(sys.stdin)['id'])")
stop_device
rm -f "$WORK/device.settings.json"
start_device "--settings {\"koServerUrl\":\"https://sync.example.org\",\"koUsername\":\"bo\",\"koPassword\":\"pw\",\"koMatchMethod\":1}"
curl -sS -X POST "$API/api/devices/discover" >/dev/null
curl -sS -X PUT -H 'content-type: application/json' -d "{\"user_id\":\"$OTHER\"}" \
  "$API/api/devices/$DEVICE_ID/settings" >/dev/null

STATE=$(curl -sS "$API/api/devices" | jqp \
  "print(json.load(sys.stdin)[0]['settings']['kosync_state'] or 'none')")
[ "$STATE" = "adopted" ] && ok "the reader's own sync server is adopted, not replaced" \
                         || bad "expected page sync to be adopted, got '$STATE'"

LEFT=$(python3 -c "
import json
got = json.load(open('$WORK/device.settings.json'))
print(got.get('koServerUrl') == 'https://sync.example.org' and got.get('koUsername') == 'bo')
")
[ "$LEFT" = "True" ] && ok "the reader itself was not written to" \
                     || bad "a deliberate setup was overwritten: $(cat "$WORK/device.settings.json")"

# Adopted into the holder's list, credentials and all, so their other readers
# can be pointed at the same server without typing anything.
ADOPTED=$(curl -sS "$API/api/users/$OTHER/servers" | python3 -c "
import json, sys
out = json.load(sys.stdin)
s = [x for x in out['servers'] if x['url'] == 'https://sync.example.org']
print(len(s) == 1 and s[0]['adopted'] and s[0]['username'] == 'bo'
      and out['servers'][0]['builtin'])
")
[ "$ADOPTED" = "True" ] && ok "it is now on Bo's list of sync servers, ours still first" \
                        || bad "adopted server missing: $(curl -sS "$API/api/users/$OTHER/servers")"

# Pinned to what it was already using, so a later sync does not drift it back.
PINNED=$(curl -sS "$API/api/devices" | jqp \
  "print(json.load(sys.stdin)[0]['settings']['sync_server_id'] or 'none')")
[ "$PINNED" != "none" ] && ok "the reader is pinned to the server it was already using" \
                        || bad "the reader was left following the default it does not use"

# Taking it over is an explicit act: unpin it, and it follows Bo's default —
# ours — which is the one thing that overwrites what the reader was holding.
curl -sS -X PUT -H 'content-type: application/json' -d '{"sync_server_id":null}' \
  "$API/api/devices/$DEVICE_ID/settings" >/dev/null
TAKEN=$(curl -sS "$API/api/kosync" | python3 -c "
import json, sys
want = json.load(sys.stdin)
bo = next(u for u in want['users'] if u['userId'] == '$OTHER')
got = json.load(open('$WORK/device.settings.json'))
print(got.get('koServerUrl') == want['url'] and got.get('koUsername') == bo['username'])
")
[ "$TAKEN" = "True" ] && ok "unpinning moves the reader to its holder's default" \
                      || bad "reader not re-pointed: $(cat "$WORK/device.settings.json")"

step "20. The OPDS catalog serves the same bytes the reader was sent"
# Off unless asked for: it publishes the books themselves, not just positions.
OFF=$(curl -sS -o /dev/null -w '%{http_code}' "$API/opds")
[ "$OFF" = "404" ] && ok "the catalog is off by default" \
                   || bad "the catalog answered HTTP $OFF before being enabled"

# Its own port, like the kosync listener, so this never collides with a running
# `deno task dev`.
OPDS="http://127.0.0.1:8897"
curl -sS -X PUT -H 'content-type: application/json' \
  -d '{"opds":{"enabled":true,"port":8897,"host":"127.0.0.1"}}' \
  "$API/api/settings" >/dev/null
sleep 1

FEED=$(curl -sS "$OPDS/opds/d/$DEVICE_ID/all")
ENTRIES=$(printf '%s' "$FEED" | grep -c '<entry>')
[ "$ENTRIES" -gt 0 ] && ok "the device's acquisition feed lists $ENTRIES book(s)" \
                     || bad "the acquisition feed was empty: $FEED"

# Atom, not "nearly Atom": a client that cannot parse it shows nothing at all.
printf '%s' "$FEED" > "$WORK/feed.xml"
python3 - "$WORK/feed.xml" <<'PY' && ok "the feed is well-formed Atom with typed acquisition links" \
                                  || bad "the feed did not parse as OPDS"
import sys, xml.etree.ElementTree as ET
feed = ET.parse(sys.argv[1]).getroot()
ns = {"a": "http://www.w3.org/2005/Atom"}
entries = feed.findall("a:entry", ns)
assert entries, "no entries"
for e in entries:
    assert e.find("a:id", ns).text.startswith("urn:md5:"), "entry id is not the source md5"
    links = [l for l in e.findall("a:link", ns)
             if l.get("rel") == "http://opds-spec.org/acquisition"]
    assert len(links) == 1, "expected exactly one acquisition link"
    assert links[0].get("type") == "application/epub+zip", links[0].get("type")
PY

# The claim that matters: pulling a book from the catalog gives the reader the
# same resampled, stamped bytes the sync engine uploaded to it — same profile,
# same cache entry — not the unoptimized original.
HREF=$(printf '%s' "$FEED" | python3 -c "
import sys, xml.etree.ElementTree as ET
ns = {'a': 'http://www.w3.org/2005/Atom'}
e = ET.fromstring(sys.stdin.read()).find('a:entry', ns)
print(next(l.get('href') for l in e.findall('a:link', ns)
           if l.get('rel') == 'http://opds-spec.org/acquisition'))
")
curl -sS -o "$WORK/pulled.epub" "$HREF"
SAME=$(python3 -c "
import hashlib, pathlib, sys
def md5(p): return hashlib.md5(p.read_bytes()).hexdigest()
want = md5(pathlib.Path('$WORK/pulled.epub'))
print(any(md5(p) == want for p in pathlib.Path('$DEV').glob('*.epub')))
")
[ "$SAME" = "True" ] && ok "a catalog download is byte-identical to the synced copy" \
                     || bad "the catalog served different bytes from the ones on the device"

# Same rails as the rest of the API: no writes, and no browsing as somebody the
# config has never heard of (reading state keys on the person).
RO=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$OPDS/opds/d/$DEVICE_ID/all")
[ "$RO" = "405" ] && ok "the catalog refuses writes" \
                  || bad "POST to the catalog returned HTTP $RO"
GHOST=$(curl -sS -o /dev/null -w '%{http_code}' "$OPDS/opds?user=nobody-by-that-name")
[ "$GHOST" = "401" ] && ok "an unknown user is refused rather than shown a default shelf" \
                     || bad "an unknown user got HTTP $GHOST"
STRANGER=$(curl -sS -o /dev/null -w '%{http_code}' "$OPDS/opds/d/not-a-real-device/all")
[ "$STRANGER" = "401" ] && ok "an unknown device id is refused" \
                        || bad "an unknown device id got HTTP $STRANGER"

step "21. The catalog is added to the reader's own OPDS list"
# The reader is an OPDS client: GET /api/opds is its catalog list, and a POST
# carrying `index` edits a slot while one without it appends.
curl -sS -X POST "$API/api/devices/$DEVICE_ID/opds" >/dev/null
LISTED=$(python3 -c "
import json
rows = json.load(open('$WORK/device.opds.json'))
mine = [r for r in rows if r['name'] == 'Pocket Sync']
print(len(mine) == 1 and '/opds/d/$DEVICE_ID' in mine[0]['url'] and mine[0]['hasPassword'])
")
[ "$LISTED" = "True" ] && ok "the reader now lists our device-scoped catalog" \
                       || bad "catalog not on the reader: $(cat "$WORK/device.opds.json")"

# The trap this endpoint sets: re-pushing without an index appends. Forcing it
# twice more must still leave exactly one entry.
curl -sS -X POST "$API/api/devices/$DEVICE_ID/opds" >/dev/null
sync_now >/dev/null
ONCE=$(python3 -c "
import json
rows = json.load(open('$WORK/device.opds.json'))
print(len([r for r in rows if r['name'] == 'Pocket Sync']))
")
[ "$ONCE" = "1" ] && ok "re-pushing edits our entry instead of duplicating it" \
                  || bad "the reader accumulated $ONCE copies of our catalog"

# Somebody else's catalog on the reader is not ours to touch.
stop_device
start_device "--catalogs [{\"name\":\"Standard_Ebooks\",\"url\":\"https://standardebooks.org/feeds/opds\",\"username\":\"\",\"filenameFormat\":\"title_author\",\"hasPassword\":false}]"
curl -sS -X POST "$API/api/devices/discover" >/dev/null
curl -sS -X POST "$API/api/devices/$DEVICE_ID/opds" >/dev/null
KEPT=$(python3 -c "
import json
rows = json.load(open('$WORK/device.opds.json'))
theirs = [r for r in rows if r['name'] == 'Standard_Ebooks']
print(len(theirs) == 1 and theirs[0]['url'] == 'https://standardebooks.org/feeds/opds'
      and len([r for r in rows if r['name'] == 'Pocket Sync']) == 1)
")
[ "$KEPT" = "True" ] && ok "a catalog the user added themselves is left alone" \
                     || bad "we trampled another catalog: $(cat "$WORK/device.opds.json")"

printf '\n\033[1m%d passed, %d failed\033[0m  (logs in %s)\n' "$pass" "$fail" "$WORK"
[ "$fail" = "0" ]
