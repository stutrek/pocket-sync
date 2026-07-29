import indexHtml from "./static/index.html" with { type: "text" };
// Generated from src/web/ui/ by `deno task ui`, which every run/build task
// depends on — the text import is resolved at compile time, so it must exist first.
import appJs from "./static/app.bundle.js" with { type: "text" };
import styleCss from "./static/style.css" with { type: "text" };

import type { App } from "../app.ts";
import type { LibraryConfig } from "../core/config.ts";
import { LOCAL_SYNC_SERVER_ID } from "../core/config.ts";
import { canPickFolder, pickFolder } from "../core/folder_dialog.ts";
import { legacyBookIdFromFilename, newId } from "../core/ids.ts";
import { lanAddress } from "../core/net.ts";
import { canonical, normalizePath, relativeToRoot, resolveUnderRoot } from "../core/roots.ts";
import { validSerial } from "../library/dedrm.ts";
import { detectDrm } from "../library/drm.ts";
import { extOf } from "../library/ingest.ts";
import { enumerate, knownSources, sourceById, sourcePath } from "../library/sources.ts";
import type { ReadingFilter } from "../library/books.ts";
import { parseScope, resolveScope } from "../library/shelf.ts";
import { type DeviceSettings, REMOVAL_CONFIRM_THRESHOLD } from "../sync/engine.ts";

type Handler = (
  req: Request,
  params: Record<string, string>,
  ctx: RequestCtx,
) => Response | Promise<Response>;

export interface RequestCtx {
  /** True when the request came from this machine. Privileged routes — the ones
   * that choose the library root or open a native dialog — require it, so a
   * `0.0.0.0` bind can't hand those to the network. */
  local: boolean;
}

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

/**
 * `{ bookIds: [...] }` from a body that may be absent — a bulk send with no
 * body is an empty selection, not a malformed request.
 */
async function bodyBookIds(req: Request): Promise<string[]> {
  try {
    const body = await req.json();
    const ids = (body as { bookIds?: unknown }).bookIds;
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

/** True when running from a compiled binary rather than `deno run`. */
function isPackaged(): boolean {
  const exe = Deno.execPath().replace(/\\/g, "/").split("/").pop() ?? "";
  return !/^deno(\.exe)?$/i.test(exe);
}

export function createHandler(
  app: App,
): (req: Request, info?: Deno.ServeHandlerInfo) => Promise<Response> {
  const routes: [string, URLPattern, Handler][] = [];
  const on = (method: string, path: string, handler: Handler) =>
    routes.push([method, new URLPattern({ pathname: path }), handler]);

  /**
   * May we write into, or delete from, this library?
   *
   * External sources — a Calibre library, Kindle's content folder — are watched
   * in place, outside the library root. That is safe *only* because they are
   * read-only, so this is the single checkpoint every write and delete goes
   * through. An unknown library id is not writable: failing closed is the only
   * safe default here (src/core/roots.ts).
   */
  const writable = (libraryId: string): boolean => {
    const lib = app.config.current.libraries.find((l) => l.id === libraryId);
    return !!lib && !lib.readOnly;
  };

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
      app.dedrm.forget();
      await app.checkDependencies();
    }
    return json({ ...app.deps, status: app.status() });
  });

  // --- library ---
  /**
   * `?scope=all | user:<id> | device:<id>` — what this shelf is *of*.
   *
   * The scope decides both which books come back and whose reading progress
   * rides along, so the client no longer has to work out which person a device
   * implies and then race its own book fetch to say so.
   */
  on("GET", "/api/library", (req) => {
    const url = new URL(req.url);
    const scope = resolveScope(parseScope(url.searchParams.get("scope")), {
      db: app.db,
      books: app.books,
      scanner: app.scanner,
      pins: app.pins,
      users: app.config.current.users,
      holderOf: (deviceId) => app.sync.settings(deviceId).user_id,
    });
    const books = app.books.list({
      query: url.searchParams.get("query") ?? undefined,
      libraryId: url.searchParams.get("library") || undefined,
      libraryIds: scope.libraryIds,
      includeBookIds: scope.includeBookIds,
      userId: scope.userId,
      reading: (url.searchParams.get("reading") as ReadingFilter) || undefined,
    });
    // Per-device state is a control in the UI, not a count, so send the ids.
    // Both relations, because "on it" and "why it is on it" are different
    // questions and the card has to answer the second to offer an un-send.
    const onDevices = new Map<string, string[]>();
    for (
      const row of app.db.all<{ book_id: string; device_id: string }>(
        "SELECT book_id, device_id FROM device_content",
      )
    ) {
      const list = onDevices.get(row.book_id);
      if (list) list.push(row.device_id);
      else onDevices.set(row.book_id, [row.device_id]);
    }
    const pinnedTo = new Map<string, string[]>();
    for (const { bookId, deviceId } of app.pins.all()) {
      const list = pinnedTo.get(bookId);
      if (list) list.push(deviceId);
      else pinnedTo.set(bookId, [deviceId]);
    }
    return json(books.map((b) => ({
      ...b,
      hasCover: !!b.cover_path,
      onDevices: onDevices.get(b.id) ?? [],
      pinnedTo: pinnedTo.get(b.id) ?? [],
    })));
  });

  /** An upload is a remote way to put a file in the watched folder; the scanner
   * picks it up from there like anything else dropped in. */
  on("POST", "/api/books", async (req) => {
    const url = new URL(req.url);
    // Default to the first folder we may actually write into: an external
    // source can sit at index 0 and must never be an upload target.
    const libraryId = url.searchParams.get("library") ||
      app.config.current.libraries.find((l) => !l.readOnly)?.id;
    const lib = app.config.current.libraries.find((l) => l.id === libraryId);
    if (!lib) return json({ error: "no watched folder configured" }, 400);
    if (!writable(lib.id)) {
      return json({ error: `“${lib.name}” is a read-only source and cannot be added to` }, 403);
    }

    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!files.length) return json({ error: "no file supplied" }, 400);
    const written: string[] = [];
    for (const file of files) {
      const data = new Uint8Array(await file.arrayBuffer());
      written.push(await app.ingest.writeUpload(lib.path, file.name, data));
    }
    app.scanner.scan(lib.id).catch(() => {});
    return json({ written, libraryId: lib.id }, 201);
  });

  on("GET", "/api/books/:id", (_req, p) => {
    const book = app.books.get(p.id);
    if (!book) return notFound();
    const meta = JSON.parse(book.meta_json || "{}");
    const devices = app.books.devicesWith(book.id).map((d) => ({
      ...d,
      name: app.devices.row(d.device_id)?.name ?? null,
    }));
    const libraries = app.books.librariesFor(book.id).map((l) => ({
      ...l,
      name: app.scanner.library(l.library_id)?.name ?? l.library_id,
      // The UI hides "Delete file" when every copy is in a read-only source —
      // the endpoint refuses anyway, but offering a button that cannot work is
      // worse than not offering it.
      readOnly: !writable(l.library_id),
    }));
    // Progress belongs to people, not folders, so report it per user.
    const reading = app.config.current.users.map((u) => ({
      userId: u.id,
      name: u.name,
      state: app.reading.get(u.id, book.id) ?? null,
    }));
    return json({
      ...book,
      hasCover: !!book.cover_path,
      epubSize: meta.epubSize ?? null,
      libraries,
      reading,
      devices,
      // Which readers were told to take this book by hand, as opposed to
      // carrying it because a folder rule covers it. The drawer needs the
      // difference: a rule-covered row must not offer an un-send that would
      // silently do nothing.
      pinnedTo: app.pins.devicesFor(book.id),
    });
  });

  /**
   * The filesystem is the source of truth, so deleting a book means deleting
   * the file the user put there. Deliberate and explicit — the app never
   * removes anything from a watched folder on its own.
   */
  on("DELETE", "/api/books/:id", async (_req, p) => {
    const book = app.books.get(p.id);
    if (!book) return notFound();

    const rows = app.books.librariesFor(p.id);
    // A book can sit in a normal folder *and* in an external source. Delete the
    // copies we own and leave the source's alone, rather than refusing outright
    // — but say so, because "deleted" would otherwise be a half-truth.
    const deletable = rows.filter((r) => writable(r.library_id));
    const kept = rows.filter((r) => !writable(r.library_id));
    if (!deletable.length) {
      return json({
        error: `“${book.title}” lives in a read-only source and is not ours to delete. ` +
          "Remove it in the application that owns it, or stop watching that source.",
      }, 403);
    }

    const removed: string[] = [];
    for (const row of deletable) {
      try {
        await Deno.remove(row.path);
        removed.push(row.path);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          return json({ error: `Could not delete ${row.path}: ${err}` }, 500);
        }
      }
      app.books.removeFromLibrary(row.library_id, p.id);
      app.db.run("DELETE FROM file_index WHERE path = ?", row.path);
    }
    app.log.info("book.deleted", `Deleted “${book.title}” from disk`, {
      bookId: p.id,
      detail: { removed, keptInReadOnly: kept.map((r) => r.path) },
    });
    return json({ ok: true, removed, keptInReadOnly: kept.map((r) => r.path) });
  });

  /** Manual finished override — the reader only reports when the user syncs. */
  on("PUT", "/api/books/:id/finished", async (req, p) => {
    const { userId, finished } = await req.json();
    if (!userId) return json({ error: "userId is required" }, 400);
    app.reading.setFinished(String(userId), p.id, !!finished);
    return json(app.reading.get(String(userId), p.id) ?? {});
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

  // --- library root ---
  /**
   * Everything watched lives under one folder the user picks once. Folders are
   * addressed relative to it, so no request can name a path outside it — see
   * src/core/roots.ts for why that matters.
   */
  on("GET", "/api/root", (_req, _p, ctx) => {
    const root = app.config.current.rootPath;
    return json({
      path: root,
      chosen: !!root,
      /** Only a local caller may open a dialog or change the root. */
      canPick: canPickFolder() && ctx.local,
      local: ctx.local,
    });
  });

  /** Open the OS folder chooser. Local callers only. */
  on("POST", "/api/root/pick", async (_req, _p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const result = await pickFolder("Choose the folder that holds your books");
    if (result.error) return json({ error: result.error }, 500);
    if (result.cancelled || !result.path) return json({ cancelled: true });
    return json(await setRoot(result.path));
  });

  /** Set the root explicitly. Local callers only; there is no text input for
   * this in the browser UI. */
  on("POST", "/api/root", async (req, _p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const { path } = await req.json().catch(() => ({ path: "" }));
    if (!path) return json({ error: "path is required" }, 400);
    const out = await setRoot(String(path));
    return out.error ? json(out, 400) : json(out);
  });

  async function setRoot(path: string) {
    // Store the on-disk form, so the config and the filesystem agree — including
    // in case, which they need not on macOS or Windows.
    const normalized = await canonical(path) ?? normalizePath(path);
    try {
      if (!(await Deno.stat(normalized)).isDirectory) {
        return { error: `${normalized} is not a folder` };
      }
    } catch (err) {
      return { error: `cannot read ${normalized}: ${err}` };
    }
    // Changing the root would orphan folders outside the new one; drop those
    // rather than leaving unreachable entries behind.
    const kept = app.config.current.libraries.filter((l) =>
      normalizePath(l.path).startsWith(`${normalized}/`) || normalizePath(l.path) === normalized
    );
    const dropped = app.config.current.libraries.filter((l) => !kept.includes(l));
    for (const l of dropped) {
      app.scanner.forget(l.id);
      app.db.run("DELETE FROM library_book WHERE library_id = ?", l.id);
      app.db.run("DELETE FROM file_index WHERE library_id = ?", l.id);
      app.db.run("DELETE FROM import_job WHERE library_id = ?", l.id);
    }
    app.config.update({ rootPath: normalized, libraries: kept });
    app.scanner.restart();
    app.log.info("root.set", `Library root is ${normalized}`, {
      detail: { dropped: dropped.map((l) => l.name) },
    });
    return { path: normalized, chosen: true, dropped: dropped.map((l) => l.name) };
  }

  /**
   * Browse folders under the root, so the browser UI can offer a picker instead
   * of a text field. `rel` is always root-relative and validated.
   */
  on("GET", "/api/root/browse", async (req) => {
    const root = app.config.current.rootPath;
    if (!root) return json({ error: "no library root chosen yet" }, 400);
    const rel = new URL(req.url).searchParams.get("rel") ?? "";
    const resolved = await resolveUnderRoot(root, rel);
    if (!resolved.path || !resolved.root) return json({ error: resolved.error }, 400);

    // Compare and slice against the *resolved* root. The configured string can
    // differ from it in case alone on macOS/Windows, and a case-sensitive
    // comparison against the wrong one makes children look like escapees.
    const base = resolved.root;
    const watched = new Set(
      await Promise.all(
        app.config.current.libraries.map(async (l) =>
          await canonical(l.path) ?? normalizePath(l.path)
        ),
      ),
    );
    const entries: { name: string; rel: string; watched: boolean; children: number }[] = [];
    for await (const entry of Deno.readDir(resolved.path)) {
      if (!entry.isDirectory || entry.name.startsWith(".")) continue;
      const abs = `${resolved.path}/${entry.name}`;
      let children = 0;
      try {
        for await (const sub of Deno.readDir(abs)) {
          if (sub.isDirectory && !sub.name.startsWith(".")) children++;
        }
      } catch { /* unreadable; show it as a leaf */ }
      entries.push({
        name: entry.name,
        rel: relativeToRoot(base, abs),
        watched: watched.has(normalizePath(abs)),
        children,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return json({
      root: base,
      rel: relativeToRoot(base, resolved.path),
      watched: watched.has(normalizePath(resolved.path)),
      entries,
    });
  });

  // --- users (a name, not an account) ---
  const usersView = () =>
    app.config.current.users.map((u) => ({
      ...u,
      ...app.kosync.credentials(u.id),
      // Ours resolved live and listed first, then anything they added or we
      // adopted off a reader — see `KosyncServer.servers()`.
      syncServers: app.kosync.servers(u.id),
      defaultSyncServerId: app.kosync.defaultServer(u.id)?.id ?? LOCAL_SYNC_SERVER_ID,
      deviceIds: app.db.all<{ device_id: string }>(
        "SELECT device_id FROM device_settings WHERE user_id = ?",
        u.id,
      ).map((r) => r.device_id),
    }));

  on("GET", "/api/users", () => json(usersView()));

  on("POST", "/api/users", async (req) => {
    const { name } = await req.json();
    if (!String(name ?? "").trim()) return json({ error: "name is required" }, 400);
    const user = { id: newId(), name: String(name).trim() };
    app.config.update({ users: [...app.config.current.users, user] });
    // Generating credentials now means the Settings page can show them at once.
    app.kosync.credentials(user.id);
    app.log.info("user.added", `Added user “${user.name}”`);
    return json(usersView().find((u) => u.id === user.id) ?? user, 201);
  });

  on("PUT", "/api/users/:id", async (req, p) => {
    const { name, defaultSyncServerId } = await req.json();
    if (!app.config.current.users.some((u) => u.id === p.id)) return notFound();
    if (name !== undefined) {
      app.config.update({
        users: app.config.current.users.map((u) =>
          u.id === p.id ? { ...u, name: String(name ?? u.name).trim() || u.name } : u
        ),
      });
    }
    if (defaultSyncServerId !== undefined) {
      const out = app.kosync.setDefaultServer(
        p.id,
        defaultSyncServerId ? String(defaultSyncServerId) : null,
      );
      if ("error" in out) return json(out, 400);
      // Readers following this person's default are now pointed somewhere else,
      // so drop the fingerprint that would otherwise short-circuit the push.
      // The next sync applies it; an online reader gets it now.
      app.db.run(
        "UPDATE device_settings SET kosync_hash = NULL WHERE user_id = ? AND sync_server_id IS NULL",
        p.id,
      );
      for (
        const row of app.db.all<{ device_id: string }>(
          "SELECT device_id FROM device_settings WHERE user_id = ? AND sync_server_id IS NULL",
          p.id,
        )
      ) {
        if (app.devices.state(row.device_id)?.online) {
          await app.sync.configureReader(row.device_id);
        }
      }
    }
    return json(usersView().find((u) => u.id === p.id) ?? {});
  });

  // --- sync servers (per person; ours is synthetic and always first) ---
  /**
   * Where this person's readers report reading progress.
   *
   * Ours is always in the list and is not stored here — it cannot be added,
   * edited or removed through these routes, only chosen as the default. The
   * others arrive either from this endpoint or from a reader that turned up
   * already pointing at one, which `configureReader()` adopts rather than
   * overwrites.
   */
  on("GET", "/api/users/:id/servers", (_req, p) => {
    if (!app.config.current.users.some((u) => u.id === p.id)) return notFound();
    return json({
      servers: app.kosync.servers(p.id),
      defaultSyncServerId: app.kosync.defaultServer(p.id)?.id ?? LOCAL_SYNC_SERVER_ID,
    });
  });

  on("POST", "/api/users/:id/servers", async (req, p) => {
    if (!app.config.current.users.some((u) => u.id === p.id)) return notFound();
    const body = await req.json();
    const out = app.kosync.addServer(p.id, {
      name: body.name === undefined ? undefined : String(body.name),
      url: String(body.url ?? ""),
      username: String(body.username ?? ""),
      password: String(body.password ?? ""),
    });
    return "error" in out ? json(out, 400) : json(out, 201);
  });

  on("PUT", "/api/users/:id/servers/:serverId", async (req, p) => {
    const body = await req.json();
    const patch: Record<string, string> = {};
    for (const k of ["name", "url", "username", "password"] as const) {
      if (body[k] !== undefined) patch[k] = String(body[k]);
    }
    const out = app.kosync.updateServer(p.id, p.serverId, patch);
    if ("error" in out) return json(out, 400);
    // Every reader on this server is now pointed at different values.
    app.db.run(
      "UPDATE device_settings SET kosync_hash = NULL WHERE sync_server_id = ?",
      p.serverId,
    );
    return json(out);
  });

  on("DELETE", "/api/users/:id/servers/:serverId", (_req, p) => {
    const out = app.kosync.removeServer(p.id, p.serverId);
    return "error" in out ? json(out, 400) : json(out);
  });

  on("DELETE", "/api/users/:id", (_req, p) => {
    app.config.update({ users: app.config.current.users.filter((u) => u.id !== p.id) });
    // Their sync servers go with them, so a pin naming one is now dangling —
    // clear it too, or the reader's next holder inherits a server that no
    // longer exists on anybody's list.
    app.db.run(
      "UPDATE device_settings SET user_id = NULL, sync_server_id = NULL WHERE user_id = ?",
      p.id,
    );
    app.kosync.forgetUser(p.id);
    app.reading.forgetUser(p.id);
    app.log.info("user.removed", `Removed user ${p.id} and their reading history`);
    return json({ ok: true });
  });

  // --- libraries (watched folders) ---
  const librariesView = () =>
    app.config.current.libraries.map((l) => ({
      ...l,
      relPath: relativeToRoot(app.config.current.rootPath, l.path),
      books: app.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM library_book WHERE library_id = ?",
        l.id,
      )!.n,
    }));

  on("GET", "/api/libraries", () => json(librariesView()));

  /**
   * `relPath` only — relative to the library root. There is deliberately no way
   * to pass an absolute path: indexed files can be read and deleted through the
   * API, so accepting one would make this an arbitrary-file endpoint.
   *
   * The library is built field by field rather than spread from the body, so
   * `external`/`readOnly` cannot be set here. Only `POST /api/sources/:id/enable`
   * creates an external library, and only from the server-side allowlist. Keep
   * it that way: a spread here would reopen the hole roots.ts closes.
   */
  on("POST", "/api/libraries", async (req) => {
    const { name, relPath } = await req.json();
    const root = app.config.current.rootPath;
    if (!root) return json({ error: "choose a library root first" }, 400);
    const resolved = await resolveUnderRoot(root, String(relPath ?? ""));
    if (!resolved.path) return json({ error: resolved.error }, 400);
    if (app.config.current.libraries.some((l) => normalizePath(l.path) === resolved.path)) {
      return json({ error: "that folder is already being watched" }, 409);
    }
    const lib: LibraryConfig = {
      id: newId(),
      name: String(name || resolved.path.split("/").filter(Boolean).pop() || "Books"),
      path: resolved.path,
      deviceIds: [],
    };
    app.config.update({ libraries: [...app.config.current.libraries, lib] });
    app.scanner.restart();
    app.log.info("library.added", `Watching “${lib.name}” at ${lib.path}`);
    return json(lib, 201);
  });

  on("PUT", "/api/libraries/:id", async (req, p) => {
    const patch = await req.json();
    const before = app.config.current.libraries.find((l) => l.id === p.id);

    /**
     * Dropping a folder rule is the ambiguous removal, so it is the one that
     * asks.
     *
     * Un-sending a book never asks — the user pointed at that book and said
     * take it off. Deleting a rule is a single click that can clear a hundred
     * books, and the reader is usually not even awake to show it happening, so
     * the count is computed *before* the config is written and the whole
     * request is refused rather than half-applied.
     */
    const confirmed = !!new URL(req.url).searchParams.get("confirmRemovals");
    if (before && Array.isArray(patch.deviceIds) && !confirmed) {
      const next = new Set(patch.deviceIds.map(String));
      for (const deviceId of before.deviceIds.filter((d) => !next.has(d))) {
        const keep = app.scanner.librariesForDevice(deviceId)
          .filter((l) => l.id !== p.id)
          .map((l) => l.id);
        const desired = new Set(app.books.idsForDevice(keep, app.pins.idsFor(deviceId)));
        const losing = app.db.all<{ book_id: string }>(
          "SELECT book_id FROM device_content WHERE device_id = ?",
          deviceId,
        ).filter((r) => !desired.has(r.book_id)).length;
        if (losing > REMOVAL_CONFIRM_THRESHOLD) {
          return json({ error: "confirm_removals", deviceId, removing: losing }, 409);
        }
      }
    }

    // Many-to-many: binding a device to this folder leaves its other folders
    // alone. Only this folder's list changes.
    const libraries = app.config.current.libraries.map((l) =>
      l.id === p.id
        ? {
          ...l,
          name: patch.name !== undefined ? String(patch.name) : l.name,
          // Path is deliberately not editable here — moving a watched folder
          // means removing it and adding the new one, which re-runs validation.
          deviceIds: Array.isArray(patch.deviceIds) ? patch.deviceIds.map(String) : l.deviceIds,
        }
        : l
    );
    app.config.update({ libraries });
    app.scanner.restart();

    /**
     * Act on the rule now, not at the reader's next connect.
     *
     * A rule is the automation of sending a book, and sending a book syncs
     * immediately — a rule that visibly does nothing until the reader happens to
     * reconnect reads as broken, and a reader that is already awake never fires
     * `onDeviceConnected` again. Fired and not awaited, like the send routes:
     * the single-flight guard collapses a burst of rule edits into one run plus
     * at most one rerun.
     *
     * Every device on either side of the change, so dropping a rule takes its
     * books off as promptly as adding one puts them on. `confirmRemovals`
     * because the 409 above already asked.
     */
    if (before && Array.isArray(patch.deviceIds)) {
      const touched = new Set([...before.deviceIds, ...patch.deviceIds.map(String)]);
      for (const deviceId of touched) {
        app.sync.sync(deviceId, "manual", { confirmRemovals: true }).catch(() => {});
      }
    }
    return json(librariesView().find((l) => l.id === p.id) ?? {});
  });

  on("DELETE", "/api/libraries/:id", (_req, p) => {
    // Order matters. Cancel in-flight work first: a scan mid-import would keep
    // converting and re-insert the rows deleted below, and a sync mid-transfer
    // would carry on uploading a folder the user just took away.
    app.scanner.forget(p.id);
    app.config.update({
      libraries: app.config.current.libraries.filter((l) => l.id !== p.id),
    });
    app.db.run("DELETE FROM library_book WHERE library_id = ?", p.id);
    app.db.run("DELETE FROM file_index WHERE library_id = ?", p.id);
    app.db.run("DELETE FROM import_job WHERE library_id = ?", p.id);
    app.scanner.restart();
    app.log.info("library.removed", `Stopped watching folder ${p.id}`);
    return json({ ok: true });
  });

  on("POST", "/api/libraries/:id/scan", async (_req, p) => {
    return json(await app.scanner.scan(p.id));
  });

  /** Drop index rows for folders that are no longer watched. Runs at startup
   * too; this is here so it can be triggered without a restart. */
  on("POST", "/api/libraries/reconcile", () => json(app.scanner.reconcile()));

  // --- reading progress (kosync) ---
  /**
   * Page sync as a whole: our own server, plus each person's list and which of
   * them their readers follow.
   *
   * Credentials are per person — that is how a progress report is attributed to
   * the right one, rather than guessed from the device name it reports.
   */
  on("GET", "/api/kosync", () => {
    const cfg = app.config.current.kosync;
    return json({
      ...cfg,
      // Resolve the address ourselves. Telling someone to go find their own LAN
      // IP is the step most likely to stall setup, and we already know it.
      url: `http://${lanAddress() ?? "127.0.0.1"}:${cfg.port}`,
      resolved: lanAddress() !== null,
      users: app.config.current.users.map((u) => ({
        userId: u.id,
        name: u.name,
        ...app.kosync.credentials(u.id),
        servers: app.kosync.servers(u.id),
        defaultSyncServerId: app.kosync.defaultServer(u.id)?.id ?? LOCAL_SYNC_SERVER_ID,
      })),
    });
  });

  // --- calibre plugins ---
  /**
   * Install DeDRM into the user's own Calibre, on request. Fetched at runtime
   * rather than bundled: the plugin has to land in Calibre's config directory
   * either way (docs/DESIGN.md). Keys stay in Calibre — we never manage them.
   */
  on("POST", "/api/calibre/dedrm", async () => {
    const release = "https://api.github.com/repos/noDRM/DeDRM_tools/releases/latest";
    let assetUrl: string;
    try {
      const meta = await fetch(release, {
        headers: { "accept": "application/vnd.github+json", "user-agent": "pocket-sync" },
      });
      if (!meta.ok) return json({ error: `GitHub returned HTTP ${meta.status}` }, 502);
      const body = await meta.json() as {
        assets?: { name: string; browser_download_url: string }[];
      };
      const asset = body.assets?.find((a) => /^DeDRM_tools.*\.zip$/i.test(a.name));
      if (!asset) return json({ error: "No DeDRM release asset found" }, 502);
      assetUrl = asset.browser_download_url;
    } catch (err) {
      return json({ error: `Could not reach GitHub: ${err}` }, 502);
    }

    const tmp = `${app.paths.tmpDir}/dedrm-${Date.now()}`;
    await Deno.mkdir(tmp, { recursive: true });
    try {
      const res = await fetch(assetUrl);
      if (!res.ok) return json({ error: `Download failed: HTTP ${res.status}` }, 502);
      const bundle = `${tmp}/DeDRM_tools.zip`;
      await Deno.writeFile(bundle, new Uint8Array(await res.arrayBuffer()));

      // The release zip contains the plugin zip; Calibre wants the inner one.
      const extracted = await app.sidecar.call<{ extracted: string | null }>("extract", {
        path: bundle,
        pattern: "DeDRM_plugin.zip",
        outDir: tmp,
      });
      await app.calibre.installPlugin(extracted.extracted ?? bundle);
      await app.checkDependencies();
      app.log.info("calibre.dedrm", "Installed the DeDRM plugin into Calibre");
      return json({ ok: true, dedrm: app.deps.calibre.dedrm });
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  });

  // --- existing e-reader libraries on this machine ---
  /**
   * These are the one exception to "nothing is watched outside the library
   * root" (src/core/roots.ts). What keeps that safe:
   *
   * - a source is chosen **by id**, and its path comes from the fixed allowlist
   *   in `src/library/sources.ts` — never from the request;
   * - the library created is `readOnly`, which `writable()` enforces at every
   *   write and delete;
   * - all three routes are loopback-only, so a LAN caller cannot enumerate what
   *   is installed on this machine or start watching it.
   */
  on("GET", "/api/sources", async (_req, _p, ctx) => {
    if (!ctx.local) return json({ local: false, sources: [] });
    const watched = new Set(
      app.config.current.libraries.map((l) => l.sourceId).filter(Boolean),
    );
    const sources = await Promise.all(
      knownSources().map(async (s) => {
        const path = await sourcePath(s);
        return {
          id: s.id,
          label: s.label,
          note: s.note,
          expectDrm: s.expectDrm,
          installed: !!path,
          path: path ?? undefined,
          watching: watched.has(s.id),
        };
      }),
    );
    return json({ local: true, sources });
  });

  /**
   * What would be imported, before anything is watched. A Kindle library with
   * no key configured would otherwise turn into hundreds of identical blocked
   * Inbox rows, so the counts are shown first and the key asked for up front.
   */
  on("POST", "/api/sources/:id/preview", async (_req, p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const source = sourceById(p.id);
    if (!source) return notFound();
    const root = await sourcePath(source);
    if (!root) return json({ error: `${source.label} is not installed here` }, 404);

    const { files, truncated } = await enumerate(source, root, 5000);
    let protectedCount = 0;
    let unopenable = 0;
    let known = 0;
    for (const file of files) {
      if (
        app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM file_index WHERE path = ?", file)!.n
      ) {
        known++;
      }
      const { drm } = await detectDrm(file, extOf(file));
      if (drm === "kfx") unopenable++;
      else if (drm) protectedCount++;
    }
    const keys = await app.dedrm.summary().catch(() => null);
    return json({
      id: source.id,
      label: source.label,
      note: source.note,
      path: root,
      books: files.length,
      truncated,
      protected: protectedCount,
      unopenable,
      known,
      dedrm: app.deps.calibre.dedrm,
      keysConfigured: keys ? keys.serials.length + keys.adobeKeys + keys.kindleKeys : 0,
    });
  });

  /** Start watching a source, as a read-only library. */
  on("POST", "/api/sources/:id/enable", async (_req, p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const source = sourceById(p.id);
    if (!source) return notFound();
    const root = await sourcePath(source);
    if (!root) return json({ error: `${source.label} is not installed here` }, 404);
    if (app.config.current.libraries.some((l) => l.sourceId === source.id)) {
      return json({ error: `${source.label} is already being watched` }, 409);
    }

    const lib: LibraryConfig = {
      id: newId(),
      name: source.label,
      // From the allowlist, never from the request body.
      path: normalizePath(root),
      deviceIds: [],
      external: true,
      readOnly: true,
      sourceId: source.id,
    };
    app.config.update({ libraries: [...app.config.current.libraries, lib] });
    app.scanner.restart();
    app.scanner.scan(lib.id).catch(() => {});
    app.log.info("source.enabled", `Watching ${source.label} at ${lib.path} (read-only)`);
    return json(lib, 201);
  });

  // --- reader keys ---
  /**
   * Kindle serials, read from and written to Calibre's own DeDRM settings.
   *
   * All of these are loopback-only. A serial is key material: it is the thing
   * that decrypts someone's purchases, and `webHost` may be `0.0.0.0`. The
   * plugin-install route above can stay open because installing a plugin
   * discloses nothing; these cannot.
   */
  on("GET", "/api/calibre/keys", async (_req, _p, ctx) => {
    if (!ctx.local) return json({ local: false, serials: [] });
    const summary = await app.dedrm.summary();
    return json({
      local: true,
      ...summary,
      stalePlugins: app.deps.calibre.stalePlugins,
      dedrm: app.deps.calibre.dedrm,
      dedrmDisabled: app.deps.calibre.dedrmDisabled,
    });
  });

  on("POST", "/api/calibre/keys/serial", async (req, _p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const { serial: raw } = await req.json().catch(() => ({ serial: "" }));
    const { serial, error } = validSerial(String(raw ?? ""));
    if (error || !serial) return json({ error }, 400);
    const added = await app.dedrm.addSerial(serial);
    // Never log the serial itself.
    app.log.info(
      "calibre.serial",
      added ? "Added a Kindle serial to Calibre's DeDRM settings" : "That serial was already set",
    );
    return json({ ok: true, added, ...(await app.dedrm.summary()) });
  });

  on("DELETE", "/api/calibre/keys/serial/:serial", async (_req, p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const removed = await app.dedrm.removeSerial(p.serial);
    if (!removed) return json({ error: "that serial is not configured" }, 404);
    app.log.info("calibre.serial", "Removed a Kindle serial from Calibre's DeDRM settings");
    return json({ ok: true, ...(await app.dedrm.summary()) });
  });

  /**
   * Remove superseded DRM plugins that no longer load. Offered because they are
   * what made `--list-plugins` mention DeDRM on a machine with no working copy.
   */
  on("POST", "/api/calibre/plugins/prune", async (_req, _p, ctx) => {
    if (!ctx.local) return json({ error: "only available on this machine" }, 403);
    const stale = app.deps.calibre.stalePlugins;
    if (!stale.length) return json({ ok: true, removed: [] });
    const removed: string[] = [];
    const failed: string[] = [];
    for (const name of stale) {
      try {
        await app.calibre.removePlugin(name);
        removed.push(name);
      } catch {
        failed.push(name);
      }
    }
    await app.checkDependencies();
    app.log.info("calibre.plugins", `Removed ${removed.length} obsolete DRM plugin(s)`, {
      detail: { removed, failed },
    });
    if (failed.length && !removed.length) {
      return json({ error: `Calibre would not remove ${failed.join(", ")}` }, 500);
    }
    return json({ ok: true, removed, failed });
  });

  // --- inbox ---
  on("GET", "/api/inbox", () => json(app.imports.all()));

  on("DELETE", "/api/inbox/:id", (_req, p) => {
    app.imports.remove(p.id);
    return json({ ok: true });
  });

  /** Re-run a job that failed or was waiting on the user. */
  on("POST", "/api/inbox/:id/retry", async (_req, p) => {
    const job = app.imports.get(p.id);
    if (!job) return notFound();
    app.db.run("DELETE FROM file_index WHERE path = ?", job.path);
    return json(await app.scanner.scan(job.library_id));
  });

  // --- devices ---
  on("GET", "/api/devices", () =>
    json(
      app.devices.view().map((d) => ({
        ...d,
        settings: app.sync.settings(d.id),
        libraryIds: app.scanner.librariesForDevice(d.id).map((l) => l.id),
        pinnedBookIds: app.pins.idsFor(d.id),
        plan: app.sync.plan(d.id),
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
            managed: !!m || !!legacyBookIdFromFilename(f.name),
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

  on("PUT", "/api/devices/:id/settings", async (req, p) => {
    const patch = await req.json() as Partial<DeviceSettings>;
    const before = app.sync.settings(p.id);
    const next = app.sync.setSettings(p.id, patch);
    // Handing the reader to someone else — or pinning it to another server —
    // changes where and as whom it should report. A sync would push that
    // eventually; doing it here means the dialog can say so while the person
    // who made the change is still looking at it.
    const repoint = next.user_id !== before.user_id ||
      next.sync_server_id !== before.sync_server_id;
    if (repoint && app.devices.state(p.id)?.online) {
      await app.sync.configureReader(p.id);
      return json(app.sync.settings(p.id));
    }
    return json(next);
  });

  /**
   * Push page-sync settings to the reader now, overriding whatever it points
   * at. The automatic path deliberately leaves a server somebody else
   * configured alone (it adopts it instead), so this is how the user says "no,
   * use the one I picked".
   */
  on(
    "POST",
    "/api/devices/:id/kosync",
    async (_req, p) => json(await app.sync.configureReader(p.id, { force: true })),
  );

  /** Push the OPDS catalog entry now, overwriting our slot in the reader's own
   * catalog list. Other catalogs on the reader are never touched. */
  on(
    "POST",
    "/api/devices/:id/opds",
    async (_req, p) => json(await app.sync.configureCatalog(p.id, { force: true })),
  );

  /** `?confirmRemovals=1` proceeds past the bulk-removal guard. */
  on("POST", "/api/devices/:id/sync", async (req, p) => {
    const confirm = !!new URL(req.url).searchParams.get("confirmRemovals");
    return json(await app.sync.sync(p.id, "manual", { confirmRemovals: confirm }));
  });

  /**
   * Send books to one reader by hand — the primitive interaction, of which a
   * folder rule is the automation.
   *
   * The sync is fired and not awaited: uploading takes minutes and the button
   * that called this should come back immediately. A burst of sends collapses
   * into one run plus at most one rerun (`#running`/`#rerun` in the engine), so
   * ticking twelve books does not queue twelve syncs.
   *
   * `confirmRemovals` is set because the user just said what they wanted. The
   * bulk-removal rail exists to catch a folder going missing, not to
   * second-guess an explicit instruction — without this, un-sending six books
   * would trip a guard and wait for a confirmation of the thing already
   * confirmed.
   */
  const sendRoute =
    (method: "PUT" | "DELETE") => async (req: Request, p: Record<string, string>) => {
      const device = app.devices.row(p.id);
      if (!device) return notFound();
      const bookIds = p.bookId ? [p.bookId] : await bodyBookIds(req);
      const unknown = bookIds.filter((id) => !app.books.get(id));
      if (unknown.length) return json({ error: `unknown book: ${unknown[0]}` }, 404);

      if (method === "PUT") app.pins.add(p.id, bookIds);
      else app.pins.remove(p.id, bookIds);

      app.sync.sync(p.id, "manual", { confirmRemovals: true }).catch(() => {});
      return json({
        sent: method === "PUT",
        online: app.devices.view().find((d) => d.id === p.id)?.state.online ?? false,
        plan: app.sync.plan(p.id),
      });
    };

  on("PUT", "/api/devices/:id/pins/:bookId", sendRoute("PUT"));
  on("DELETE", "/api/devices/:id/pins/:bookId", sendRoute("DELETE"));
  // Bulk forms, so selecting twelve books is one request and one sync.
  on("PUT", "/api/devices/:id/pins", sendRoute("PUT"));
  on("DELETE", "/api/devices/:id/pins", sendRoute("DELETE"));

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
      app.dedrm.forget();
      app.checkDependencies().catch(() => {});
    }

    // Both schedulers fix their interval when started, so an edited cadence has
    // to re-arm the timer or it is reported but not honoured.
    if (patch.discovery !== undefined) app.devices.restart();
    if (patch.scan !== undefined) app.scanner.restart();

    // Our sync server binds a port, so the switch and the port only mean
    // anything if the listener follows them — otherwise the setting reads as
    // applied while readers keep reporting to the old one, or to nothing.
    if (patch.kosync !== undefined) {
      await app.kosync.applyConfig();
      // Its URL is part of what every reader on it was told. A moved port has
      // to be re-pushed, so drop the fingerprints that would suppress that.
      if (patch.kosync.port !== undefined && patch.kosync.port !== before.kosync.port) {
        app.db.run("UPDATE device_settings SET kosync_hash = NULL");
      }
    }

    // Same reasoning for the catalog: its switch and port mean nothing unless
    // the listener follows them, and its URL is part of what readers were told.
    if (patch.opds !== undefined) {
      await app.opds.applyConfig();
      const moved = patch.opds.port !== undefined && patch.opds.port !== before.opds.port;
      if (moved || patch.opds.enabled !== undefined) {
        app.db.run("UPDATE device_settings SET opds_hash = NULL");
      }
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

  // --- OPDS ---
  //
  // The catalog's own LAN listener is what readers use (src/web/opds.ts). It is
  // mounted here as well so it can be browsed and tested from this machine
  // without putting the listener on the network — same handler, so there is one
  // implementation of the scoping rules, and `opds.enabled` still gates it.
  const opds: Handler = (req) => app.opds.handler(req);
  on("GET", "/opds", opds);
  on("GET", "/opds/*", opds);

  /** What to show the user, and what to hand a reader that cannot be configured
   * automatically. Mirrors `GET /api/kosync`. */
  on("GET", "/api/opds", () => {
    const cfg = app.config.current.opds;
    const url = app.opds.url();
    return json({
      ...cfg,
      url,
      // Null once means "no LAN address"; null per device means the same. The UI
      // needs both so it can explain a blank field rather than just show one.
      devices: app.devices.rows().map((d) => ({
        id: d.id,
        name: d.name,
        url: app.opds.catalogUrl(d.id),
      })),
      reason: !cfg.enabled
        ? "The OPDS catalog is turned off in Settings"
        : url
        ? null
        : "No LAN address — a reader on the Wi-Fi has no way to reach this machine",
    });
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

  return async (req: Request, info?: Deno.ServeHandlerInfo): Promise<Response> => {
    const url = new URL(req.url);
    const addr = info?.remoteAddr;
    const host = addr && addr.transport === "tcp" ? addr.hostname : "";
    const ctx: RequestCtx = {
      // No remote address means a unix socket or an in-process call, both local.
      local: !addr || host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1",
    };
    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) continue;
      const match = pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      try {
        return await handler(req, match.pathname.groups as Record<string, string>, ctx);
      } catch (err) {
        app.log.error("http.error", `${req.method} ${url.pathname}: ${err}`);
        return json({ error: String(err instanceof Error ? err.message : err) }, 500);
      }
    }
    return notFound();
  };
}
