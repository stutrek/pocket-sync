import indexHtml from "./static/index.html" with { type: "text" };
import appJs from "./static/app.js" with { type: "text" };
import styleCss from "./static/style.css" with { type: "text" };

import type { App } from "../app.ts";
import { bookIdFromDeviceFilename } from "../core/ids.ts";
import type { SyncRule } from "../sync/engine.ts";

type Handler = (req: Request, params: Record<string, string>) => Response | Promise<Response>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const text = (body: string, contentType: string) =>
  new Response(body, {
    headers: { "content-type": contentType, "cache-control": "no-cache" },
  });

const notFound = () => json({ error: "not found" }, 404);

/** True when running from a compiled binary rather than `deno run`. */
function isPackaged(): boolean {
  const exe = Deno.execPath().replace(/\\/g, "/").split("/").pop() ?? "";
  return !/^deno(\.exe)?$/i.test(exe);
}

export function createHandler(app: App): (req: Request) => Promise<Response> {
  const routes: [string, URLPattern, Handler][] = [];
  const on = (method: string, path: string, handler: Handler) =>
    routes.push([method, new URLPattern({ pathname: path }), handler]);

  // --- static ---
  on("GET", "/", () => text(indexHtml, "text/html; charset=utf-8"));
  on("GET", "/index.html", () => text(indexHtml, "text/html; charset=utf-8"));
  on("GET", "/app.js", () => text(appJs, "text/javascript; charset=utf-8"));
  on("GET", "/style.css", () => text(styleCss, "text/css; charset=utf-8"));

  // --- status ---
  on("GET", "/api/status", () => json(app.status()));
  /** `?recheck=1` re-probes Calibre after the user installs it or edits paths. */
  on("GET", "/api/health", async (req) => {
    if (new URL(req.url).searchParams.get("recheck")) {
      app.calibre.forget();
      await app.checkDependencies();
    }
    return json({ ...app.deps, status: app.status() });
  });

  // --- library ---
  on("GET", "/api/library", (req) => {
    const url = new URL(req.url);
    const books = app.books.list({
      query: url.searchParams.get("query") ?? undefined,
      listId: url.searchParams.get("list") || undefined,
    });
    const counts = new Map<string, number>();
    for (
      const row of app.db.all<{ book_id: string; n: number }>(
        "SELECT book_id, COUNT(*) AS n FROM device_content GROUP BY book_id",
      )
    ) counts.set(row.book_id, row.n);
    return json(books.map((b) => ({
      ...b,
      hasCover: !!b.cover_path,
      onDevices: counts.get(b.id) ?? 0,
    })));
  });

  on("POST", "/api/books", async (req) => {
    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!files.length) return json({ error: "no file supplied" }, 400);
    const added = [];
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      const book = await app.ingest.addFile(file.name, data);
      added.push({ ...book, converted: book.original_ext !== "epub" });
    }
    return json(added.length === 1 ? added[0] : added, 201);
  });

  on("GET", "/api/books/:id", (_req, p) => {
    const book = app.books.get(p.id);
    if (!book) return notFound();
    const meta = JSON.parse(book.meta_json || "{}");
    const devices = app.books.devicesWith(book.id).map((d) => ({
      ...d,
      name: app.devices.row(d.device_id)?.name ?? null,
    }));
    return json({
      ...book,
      hasCover: !!book.cover_path,
      epubSize: meta.epubSize ?? null,
      lists: app.books.listsFor(book.id),
      devices,
    });
  });

  on("DELETE", "/api/books/:id", (_req, p) => {
    if (!app.books.get(p.id)) return notFound();
    app.books.remove(p.id);
    app.log.info("book.deleted", `Book ${p.id} deleted`, { bookId: p.id });
    return json({ ok: true });
  });

  on("GET", "/api/books/:id/cover", async (_req, p) => {
    const book = app.books.get(p.id);
    if (!book?.cover_path) return notFound();
    try {
      const bytes = await Deno.readFile(book.cover_path);
      return new Response(bytes, {
        headers: { "content-type": "image/jpeg", "cache-control": "max-age=86400" },
      });
    } catch {
      return notFound();
    }
  });

  on("GET", "/api/books/:id/download", async (_req, p) => {
    const book = app.books.get(p.id);
    if (!book?.epub_path) return notFound();
    const bytes = await Deno.readFile(book.epub_path);
    return new Response(bytes, {
      headers: {
        "content-type": "application/epub+zip",
        "content-disposition": `attachment; filename="${book.title.replace(/"/g, "")}.epub"`,
      },
    });
  });

  /** Produce (and cache) the optimized copy for a profile — useful to preview
   * exactly what a device would receive. */
  on("GET", "/api/books/:id/optimized", async (req, p) => {
    const book = app.books.get(p.id);
    if (!book) return notFound();
    const profileId = new URL(req.url).searchParams.get("profile");
    const profile = profileId ? app.profiles.get(profileId) ?? null : null;
    if (profileId && !profile) return json({ error: "no such profile" }, 400);
    const { path, optimized } = await app.profiles.fileForSend(book, profile);
    const bytes = await Deno.readFile(path);
    return new Response(bytes, {
      headers: {
        "content-type": "application/epub+zip",
        "x-optimized": String(optimized),
        "content-disposition": `attachment; filename="${book.id}.epub"`,
      },
    });
  });

  /** Forget that this book is on any device, so the next sync re-sends it. */
  on("POST", "/api/books/:id/resend", (_req, p) => {
    app.db.run("DELETE FROM device_content WHERE book_id = ?", p.id);
    return json({ ok: true });
  });

  // --- lists ---
  on("GET", "/api/lists", () => json(app.lists.all()));
  on("POST", "/api/lists", async (req) => {
    const { name } = await req.json();
    return json(app.lists.create(String(name ?? "")), 201);
  });
  on("PUT", "/api/lists/:id", async (req, p) => {
    const { name } = await req.json();
    app.lists.rename(p.id, String(name ?? ""));
    return json(app.lists.get(p.id) ?? {});
  });
  on("DELETE", "/api/lists/:id", (_req, p) => {
    app.lists.remove(p.id);
    return json({ ok: true });
  });
  on("POST", "/api/lists/:id/items", async (req, p) => {
    const { bookIds } = await req.json();
    app.lists.addItems(p.id, bookIds ?? []);
    return json(app.lists.get(p.id) ?? {});
  });
  on("DELETE", "/api/lists/:id/items", async (req, p) => {
    const { bookIds } = await req.json();
    app.lists.removeItems(p.id, bookIds ?? []);
    return json(app.lists.get(p.id) ?? {});
  });

  // --- devices ---
  on("GET", "/api/devices", () =>
    json(
      app.devices.view().map((d) => ({
        ...d,
        rule: app.sync.rule(d.id),
        contentCount: app.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM device_content WHERE device_id = ?",
          d.id,
        )!.n,
      })),
    ));

  on("POST", "/api/devices/discover", async () => {
    await app.devices.sweep();
    return json({ devices: app.devices.view().length });
  });

  on("PATCH", "/api/devices/:id", async (req, p) => {
    const { name } = await req.json();
    app.devices.rename(p.id, String(name ?? ""));
    return json(app.devices.row(p.id) ?? {});
  });

  on("DELETE", "/api/devices/:id", (_req, p) => {
    app.devices.remove(p.id);
    return json({ ok: true });
  });

  /** Live listing from the device, joined with what we believe we put there. */
  on("GET", "/api/devices/:id/contents", async (_req, p) => {
    const manifest = new Map(
      app.sync.contents(p.id).map((row) => {
        const r = row as Record<string, unknown>;
        return [String(r.device_path), r];
      }),
    );
    const client = app.devices.clientFor(p.id);
    let files: unknown[] = [];
    let error: string | undefined;
    if (client) {
      try {
        files = (await client.listEpubs("/")).map((f) => {
          const m = manifest.get(f.path) as Record<string, unknown> | undefined;
          return {
            path: f.path,
            size: f.size,
            title: m?.title ?? null,
            synced_at: m?.synced_at ?? null,
            managed: !!m || !!bookIdFromDeviceFilename(f.name),
          };
        });
      } catch (err) {
        error = `Device unreachable: ${err}`;
      }
    } else {
      error = "Device address unknown — wait for the next scan.";
    }
    if (error) {
      files = [...manifest.values()].map((m) => {
        const r = m as Record<string, unknown>;
        return {
          path: r.device_path,
          size: r.size_bytes,
          title: r.title,
          synced_at: r.synced_at,
          managed: true,
        };
      });
    }
    return json({ files, error });
  });

  on("PUT", "/api/devices/:id/rule", async (req, p) => {
    const patch = await req.json() as Partial<SyncRule>;
    return json(app.sync.setRule(p.id, patch));
  });

  on("POST", "/api/devices/:id/sync", async (_req, p) => {
    const result = await app.sync.sync(p.id, "manual");
    return json(result);
  });

  // --- profiles ---
  on("GET", "/api/profiles", () => json(app.profiles.all()));
  on("POST", "/api/profiles", async (req) => {
    const body = await req.json();
    return json(app.profiles.create(body), 201);
  });
  on("PUT", "/api/profiles/:id", async (req, p) => {
    const updated = app.profiles.update(p.id, await req.json());
    return updated ? json(updated) : notFound();
  });
  on("DELETE", "/api/profiles/:id", (_req, p) => {
    app.profiles.remove(p.id);
    return json({ ok: true });
  });

  // --- settings ---
  on("GET", "/api/settings", async () => {
    const { isEnabled } = await import("../desktop/autostart.ts");
    return json({ ...app.config.current, startAtLogin: await isEnabled() });
  });

  on("PUT", "/api/settings", async (req) => {
    const patch = await req.json() as Partial<typeof app.config.current>;
    const before = app.config.current;
    const next = app.config.update(patch);
    app.log.setLevel(next.logLevel);

    // Calibre/Python paths are cached after resolution — re-probe when they move.
    if (
      patch.calibrePath !== undefined && patch.calibrePath !== before.calibrePath ||
      patch.ebookMetaPath !== undefined && patch.ebookMetaPath !== before.ebookMetaPath
    ) {
      app.calibre.forget();
      app.checkDependencies().catch(() => {});
    }

    if (patch.startAtLogin !== undefined && patch.startAtLogin !== before.startAtLogin) {
      const { setEnabled } = await import("../desktop/autostart.ts");
      if (isPackaged()) {
        const applied = await setEnabled(patch.startAtLogin, app.log, app.paths.dataDir);
        app.config.update({ startAtLogin: applied });
      } else {
        app.log.warn(
          "autostart.dev",
          "Start at login only applies to the packaged app, not `deno task dev`",
        );
        app.config.update({ startAtLogin: false });
      }
    }

    app.log.info("settings.updated", "Settings updated");
    const { isEnabled } = await import("../desktop/autostart.ts");
    return json({ ...app.config.current, startAtLogin: await isEnabled() });
  });

  // --- logs + events ---
  on("GET", "/api/logs", async (req) => {
    const url = new URL(req.url);
    const since = Number(url.searchParams.get("since") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 300);
    const recent = app.bus.recent(since, limit);
    if (recent.length || since > 0) return json(recent);
    return json(await app.log.tail(limit));
  });

  on("GET", "/api/events", () => {
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: string) => {
          try {
            controller.enqueue(enc.encode(data));
          } catch { /* client gone */ }
        };
        send(": connected\n\n");
        const keepalive = setInterval(() => send(": ping\n\n"), 20000);
        const off = app.bus.subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
        unsubscribe = () => {
          clearInterval(keepalive);
          off();
        };
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      try {
        return await handler(req, match.pathname.groups as Record<string, string>);
      } catch (err) {
        app.log.error("http.error", `${req.method} ${url.pathname}: ${err}`);
        return json({ error: String(err instanceof Error ? err.message : err) }, 500);
      }
    }
    return notFound();
  };
}
