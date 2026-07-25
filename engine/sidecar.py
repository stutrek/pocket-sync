#!/usr/bin/env python3
"""Pocket Sync engine sidecar.

Thin JSON-lines wrapper around the *unmodified* CrossPoint Calibre plugin
modules vendored under ``engine/vendor/crosspoint_reader`` (see
``fetch_vendor.sh``). Nothing here reimplements the optimizer or the device
protocol — it only marshals arguments and streams progress back to the Deno
daemon, so upstream fixes can be pulled in by re-running the fetch script.

Protocol (one JSON object per line, both directions):

    ->  {"id": 1, "cmd": "optimize", "args": {...}}
    <-  {"id": 1, "type": "event",  "tag": "IMG", "message": "..."}
    <-  {"id": 1, "type": "result", "result": {...}}
    <-  {"id": 1, "type": "error",  "error": "..."}

Each command runs on its own thread so a slow optimize does not block a
discovery sweep; stdout writes are serialized by a lock.
"""

import json
import os
import sys
import threading
import time
import traceback

VENDOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
sys.path.insert(0, VENDOR_DIR)

_out_lock = threading.Lock()


def send(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def _vendor():
    """Import the vendored upstream modules (deferred: gives a clean error)."""
    from crosspoint_reader import optimizer, ws_client  # noqa: WPS433
    return optimizer, ws_client


# --- commands --------------------------------------------------------------

def cmd_ping(_args, _emit):
    info = {"python": sys.version.split()[0], "vendorDir": VENDOR_DIR}
    for mod, key in (("PIL", "pillow"), ("lxml", "lxml")):
        try:
            __import__(mod)
            info[key] = True
        except Exception as exc:
            info[key] = False
            info[key + "Error"] = str(exc)
    try:
        optimizer, _ws = _vendor()
        info["vendor"] = True
        info["deviceProfiles"] = optimizer.DEVICE_PROFILES
    except Exception as exc:
        info["vendor"] = False
        info["vendorError"] = str(exc)
    return info


def cmd_optimize(args, emit):
    optimizer, _ws = _vendor()
    in_path = args["inPath"]
    out_path = args["outPath"]
    key, profile = optimizer.resolve_profile(args.get("deviceModel"), args.get("detectedModel"))
    opts = optimizer.Options(
        quality=args.get("quality", optimizer.DEFAULT_JPEG_QUALITY),
        grayscale=args.get("grayscale", True),
        auto_crop=args.get("autoCrop", False),
        split_text=args.get("splitText", True),
    )
    tmp_path = out_path + ".part"
    last = [0.0]

    def log_fn(tag, message):
        # Per-image chatter is throttled; structural steps always pass through.
        now = time.time()
        if tag in ("IMG", "CROP") and now - last[0] < 0.5:
            return
        last[0] = now
        emit({"tag": tag, "message": message})

    try:
        summary = optimizer.optimize_epub(in_path, tmp_path, profile, opts, log_fn)
        os.replace(tmp_path, out_path)
    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise
    summary = dict(summary or {})
    summary["profileKey"] = key
    summary["profile"] = profile
    return summary


def cmd_discover(args, emit):
    _optimizer, ws_client = _vendor()
    host, port = ws_client.discover_device(
        timeout=float(args.get("timeout", 2.0)),
        debug=bool(args.get("debug", False)),
        logger=lambda msg: emit({"tag": "DISCOVER", "message": msg}),
        extra_hosts=args.get("extraHosts") or [],
    )
    return {"host": host, "port": port} if host else {"host": None, "port": None}


def cmd_upload(args, emit):
    _optimizer, ws_client = _vendor()
    size = os.path.getsize(args["filePath"])
    state = {"t": 0.0, "sent": 0}

    def progress_cb(sent, total):
        state["sent"] = sent
        now = time.time()
        if now - state["t"] < 0.25 and sent < total:
            return
        state["t"] = now
        emit({"tag": "PROGRESS", "sent": sent, "total": total})

    try:
        ws_client.upload_file(
            args["host"],
            int(args.get("port", 81)),
            args.get("uploadPath", "/"),
            args["filename"],
            args["filePath"],
            chunk_size=min(int(args.get("chunkSize", 2048)), 2048),
            debug=bool(args.get("debug", False)),
            progress_cb=progress_cb,
            logger=lambda msg: emit({"tag": "WS", "message": msg}),
            timeout=int(args.get("timeout", 30)),
        )
    except ws_client.UploadError as exc:
        # `uploadStarted` tells the daemon whether a partial file needs deleting.
        raise SidecarError(str(exc), {"uploadStarted": bool(exc.upload_started)})
    return {"sent": state["sent"], "size": size}


class SidecarError(Exception):
    def __init__(self, message, data=None):
        super().__init__(message)
        self.data = data or {}


COMMANDS = {
    "ping": cmd_ping,
    "optimize": cmd_optimize,
    "discover": cmd_discover,
    "upload": cmd_upload,
}


def handle(req):
    req_id = req.get("id")
    cmd = req.get("cmd")
    fn = COMMANDS.get(cmd)
    if fn is None:
        send({"id": req_id, "type": "error", "error": "unknown command: %s" % cmd})
        return

    def emit(payload):
        msg = {"id": req_id, "type": "event"}
        msg.update(payload)
        send(msg)

    try:
        result = fn(req.get("args") or {}, emit)
        send({"id": req_id, "type": "result", "result": result})
    except SidecarError as exc:
        send({"id": req_id, "type": "error", "error": str(exc), "data": exc.data})
    except Exception as exc:
        send({
            "id": req_id,
            "type": "error",
            "error": "%s: %s" % (type(exc).__name__, exc),
            "data": {"traceback": traceback.format_exc()[-2000:]},
        })


def main():
    send({"type": "ready", "pid": os.getpid()})
    workers = []
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError as exc:
            send({"type": "error", "error": "bad request json: %s" % exc})
            continue
        worker = threading.Thread(target=handle, args=(req,))
        worker.start()
        workers.append(worker)
        workers = [w for w in workers if w.is_alive()]
    # stdin closed: let in-flight commands finish before exiting.
    for worker in workers:
        worker.join()


if __name__ == "__main__":
    main()
