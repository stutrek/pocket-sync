/**
 * A stand-in for a CrossInk reader, so the sync engine can be exercised end to
 * end without hardware. Implements the confirmed protocol (§8): the HTTP API
 * and the WebSocket upload handshake, backed by a directory on disk.
 *
 *   deno run -A tests/fake_device.ts --root /tmp/fakedev --http 8099 --ws 8098
 *
 * Then add "127.0.0.1:8099" to Settings → Discovery → manual hosts.
 */
const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length; i += 2) {
  args.set(Deno.args[i].replace(/^--/, ""), Deno.args[i + 1]);
}

const ROOT = args.get("root") ?? await Deno.makeTempDir({ prefix: "fake-device-" });
const HTTP_PORT = Number(args.get("http") ?? 8099);
const WS_PORT = Number(args.get("ws") ?? 8098);
const MODEL = args.get("model") ?? "X4";
const UUID = args.get("uuid") ?? "FAKE-CROSSINK-0001";
/** Set to fail the Nth upload once, to exercise retry/cleanup paths. */
const FAIL_UPLOAD = Number(args.get("fail-upload") ?? 0);
/** Drop the connection mid-transfer on this upload index (1-based). */
const DROP_UPLOAD = Number(args.get("drop-upload") ?? 0);

await Deno.mkdir(ROOT, { recursive: true });
let uploadCount = 0;

const localPath = (devicePath: string) =>
  `${ROOT}/${devicePath.replace(/^\/+/, "").replace(/\.\./g, "")}`;

async function listDir(devicePath: string) {
  const out = [];
  try {
    for await (const entry of Deno.readDir(localPath(devicePath))) {
      const st = await Deno.stat(`${localPath(devicePath)}/${entry.name}`).catch(() => null);
      out.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isEpub: entry.isFile && entry.name.toLowerCase().endsWith(".epub"),
        size: st?.size ?? 0,
      });
    }
  } catch { /* missing dir -> empty listing */ }
  return out;
}

Deno.serve({ port: HTTP_PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  const p = url.pathname;
  console.log(`[fake-device] ${req.method} ${p}${url.search}`);

  if (p === "/api/status") {
    return Response.json({
      device: MODEL,
      uuid: UUID,
      wsPort: WS_PORT,
      firmware: "fake-1.0",
      battery: 87,
    });
  }

  if (p === "/api/files") {
    return Response.json(await listDir(url.searchParams.get("path") ?? "/"));
  }

  if (p === "/download") {
    const file = localPath(url.searchParams.get("path") ?? "");
    try {
      return new Response(await Deno.readFile(file));
    } catch {
      return new Response("not found", { status: 404 });
    }
  }

  if (p === "/delete" && req.method === "POST") {
    const form = await req.formData();
    const paths = JSON.parse(String(form.get("paths") ?? "[]")) as string[];
    for (const path of paths) {
      await Deno.remove(localPath(path)).catch(() => {});
      console.log(`[fake-device] deleted ${path}`);
    }
    return new Response("ok");
  }

  if (p === "/mkdir" && req.method === "POST") {
    const form = await req.formData();
    const name = String(form.get("name") ?? "");
    const parent = String(form.get("path") ?? "/");
    const dir = `${localPath(parent)}/${name}`;
    try {
      await Deno.mkdir(dir);
    } catch {
      return new Response("exists", { status: 400 }); // firmware behaviour
    }
    return new Response("ok");
  }

  return new Response("not found", { status: 404 });
});

Deno.serve({ port: WS_PORT, hostname: "127.0.0.1" }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  let target: string | null = null;
  let expected = 0;
  let received = 0;
  let chunks: Uint8Array[] = [];
  let index = 0;

  socket.onmessage = async (e) => {
    if (typeof e.data === "string") {
      const m = /^START:(.*):(\d+):(.*)$/.exec(e.data);
      if (!m) return socket.send("ERROR:bad start");
      index = ++uploadCount;
      if (FAIL_UPLOAD === index) return socket.send("ERROR:simulated failure");
      const [, filename, size, dir] = m;
      target = `${localPath(dir)}/${filename}`.replace(/\/+/g, "/");
      expected = Number(size);
      received = 0;
      chunks = [];
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      console.log(`[fake-device] START ${filename} (${size} bytes) -> ${dir}`);
      socket.send("READY");
      return;
    }
    const bytes = new Uint8Array(
      e.data instanceof ArrayBuffer ? e.data : await (e.data as Blob).arrayBuffer(),
    );
    if (bytes.length > 2048) {
      socket.send("ERROR:chunk too large"); // firmware cap
      return;
    }
    chunks.push(bytes);
    received += bytes.length;
    if (DROP_UPLOAD === index && received > expected / 2) {
      // Write the partial file, then vanish — as a sleeping device would.
      const partial = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        partial.set(c, off);
        off += c.length;
      }
      await Deno.writeFile(target!, partial);
      console.log(`[fake-device] dropping connection mid-upload at ${received}/${expected}`);
      socket.close();
      return;
    }
    if (received >= expected) {
      const all = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        all.set(c, off);
        off += c.length;
      }
      await Deno.writeFile(target!, all);
      console.log(`[fake-device] DONE ${target} (${received} bytes)`);
      socket.send("DONE");
    }
  };
  socket.onerror = () => {};
  return response;
});

console.log(
  `[fake-device] ${MODEL} ready — http://127.0.0.1:${HTTP_PORT}, ws://127.0.0.1:${WS_PORT}, root ${ROOT}`,
);
