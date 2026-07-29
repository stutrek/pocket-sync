/**
 * An OPDS 1.2 catalog over the library, so a reader can come and *fetch* books
 * instead of only ever being pushed them.
 *
 * Two things make this more than a listing endpoint:
 *
 * **The device is in the path.** `/opds/d/<deviceId>/…` resolves that device's
 * resample profile, so an acquisition link hands back the same optimized copy
 * the sync engine would have uploaded — out of the same `opt-<hash>.epub`
 * cache, so a book already synced downloads instantly. A catalog that served
 * unresampled EPUBs to a reader with ~380 KB of layout RAM would be a good way
 * to crash it (`pocket-overview` invariant 6).
 *
 * **Every download goes through `SyncEngine.prepareForDevice()`**, the same
 * call the upload path uses. A book pulled from here is stamped with its source
 * md5 and its document hashes are recorded, so page sync attributes it exactly
 * like a pushed one. Skipping that would make hand-pulled books silently
 * invisible to reading state.
 *
 * ## Authentication, and why there is so little of it
 *
 * There is no password. A device id in a URL is not a secret — it is a hash of
 * the reader's serial (`stableIdentity()`) — and the Basic username, if a
 * client sends one, only *selects a person*; the password is ignored. That is a
 * deliberate choice for a household LAN, where the alternative is typing a
 * generated password on an e-ink keyboard, and where the same listener's
 * neighbours already serve book files unauthenticated.
 *
 * What that buys has a hard edge, so it is worth stating: **anything that can
 * reach this port can download the whole library.** The protections are that
 * the catalog is off by default (`opds.enabled`), that it binds its own
 * listener rather than riding on the library UI's — which is loopback-only by
 * default and must stay that way — and that nothing here writes, deletes or
 * reveals a filesystem path. It is a read-only view of book bytes and nothing
 * else. Don't add a route that breaks any of those three.
 *
 * A supplied-but-unknown username is rejected rather than falling back to the
 * first user: reading state keys on the person (invariant 5), and quietly
 * serving somebody else's shelf is worse than an error.
 */
import type { ConfigStore } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import { lanAddress } from "../core/net.ts";
import type { Book, Books, LibraryRow, ReadingFilter } from "../library/books.ts";
import type { DeviceManager } from "../device/manager.ts";
import type { SyncEngine } from "../sync/engine.ts";
import { relativeDirSegments } from "../sync/engine.ts";
import type { Profiles, ResampleProfile } from "../sync/profiles.ts";

const ATOM = "http://www.w3.org/2005/Atom";
const NAV_TYPE = "application/atom+xml;profile=opds-catalog;kind=navigation";
const ACQ_TYPE = "application/atom+xml;profile=opds-catalog;kind=acquisition";
const ACQUISITION_REL = "http://opds-spec.org/acquisition";
const IMAGE_REL = "http://opds-spec.org/image";
const THUMB_REL = "http://opds-spec.org/image/thumbnail";

/** Books per acquisition feed. E-ink clients repaint the whole list on every
 * page, so a large one is slow to read rather than merely large. */
const PAGE_SIZE = 50;

/**
 * Who is asking and what they should get. A device scope knows the hardware, so
 * it resamples; a user scope is some other OPDS client — KOReader on a phone,
 * Calibre — which gets the original unless it asks for a profile by id.
 */
interface Scope {
  /** Whose reading state decorates the feed. */
  userId: string | null;
  /** Null for a user scope: no device, so nothing to resample for. */
  deviceId: string | null;
  profile: ResampleProfile | null;
  /** Absolute prefix every link in the feed is built from. */
  base: string;
  title: string;
}

export class OpdsServer {
  #server: Deno.HttpServer | null = null;
  /** Where the listener is actually bound, so `applyConfig()` can tell a no-op
   * change from one that has to rebind. */
  #at: { port: number; host: string } | null = null;

  constructor(
    private readonly config: ConfigStore,
    private readonly books: Books,
    private readonly devices: DeviceManager,
    private readonly sync: SyncEngine,
    private readonly profiles: Profiles,
    private readonly log: Logger,
  ) {}

  /** The catalog's root URL as a reader on the LAN would reach it, or null if
   * we cannot work out an address that leaves this machine. */
  url(): string | null {
    if (!this.config.current.opds.enabled) return null;
    const host = lanAddress();
    return host ? `http://${host}:${this.config.current.opds.port}/opds` : null;
  }

  /**
   * The catalog URL for one reader — what gets written into its settings.
   *
   * Device-scoped rather than the bare root because the id is what selects the
   * resample profile: the same book downloaded through this URL and through the
   * root are different bytes, and only these are safe for the hardware.
   */
  catalogUrl(deviceId: string): string | null {
    const root = this.url();
    return root ? `${root}/d/${encodeURIComponent(deviceId)}` : null;
  }

  // --- scopes ---

  /**
   * Resolve the person this request speaks for.
   *
   * Basic auth first (username only — any password, including none, because a
   * fair number of OPDS clients will not send an empty one), then `?user=` for
   * clients with no credential UI at all, then the device's holder, then the
   * only sensible default when nobody said anything. Accepts a user's name as
   * well as their id: the id is a generated string nobody wants to type.
   */
  #userFor(req: Request, fallback: string | null): { userId: string | null } | "unknown" {
    const users = this.config.current.users ?? [];
    const url = new URL(req.url);
    let claimed = url.searchParams.get("user") ?? "";

    const auth = req.headers.get("authorization") ?? "";
    if (/^basic /i.test(auth)) {
      try {
        const decoded = atob(auth.slice(6).trim());
        const name = decoded.slice(
          0,
          decoded.indexOf(":") === -1 ? undefined : decoded.indexOf(":"),
        );
        if (name) claimed = name;
      } catch { /* not base64 — treat as no credentials at all */ }
    }

    if (!claimed) return { userId: fallback ?? users[0]?.id ?? null };
    const match = users.find((u) =>
      u.id === claimed || u.name.toLowerCase() === claimed.toLowerCase()
    );
    return match ? { userId: match.id } : "unknown";
  }

  /** The scope for `/opds/d/:deviceId/…`, or null if we have never seen it. */
  #deviceScope(req: Request, deviceId: string, origin: string): Scope | null {
    const row = this.devices.row(deviceId);
    if (!row) return null;
    const settings = this.sync.settings(deviceId);
    const user = this.#userFor(req, settings.user_id);
    if (user === "unknown") return null;
    return {
      userId: user.userId,
      deviceId,
      profile: this.sync.profileFor(deviceId),
      // Every watched folder, not just the ones bound to this reader. Sync is
      // what a device is *given*; the catalog is what it can *go and get*, and
      // the whole point of pulling is to reach a book the push never sent.
      base: `${origin}/opds/d/${encodeURIComponent(deviceId)}`,
      title: row.name || "Pocket Sync",
    };
  }

  /** The scope for the bare `/opds` root: a person, every folder, no resampling
   * unless `?profile=` names one. */
  #userScope(req: Request, origin: string): Scope | null {
    const user = this.#userFor(req, null);
    if (user === "unknown") return null;
    const profileId = new URL(req.url).searchParams.get("profile");
    return {
      userId: user.userId,
      deviceId: null,
      // No device means no hardware to match, so the original is the honest
      // default; a client that knows what it is running can name a profile.
      profile: profileId ? this.profiles.get(profileId) ?? null : null,
      base: `${origin}/opds`,
      title: "Pocket Sync",
    };
  }

  // --- the listener ---

  handler = async (req: Request): Promise<Response> => {
    if (!this.config.current.opds.enabled) return notFound();
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Read-only by construction, and worth saying so explicitly rather than
      // 404ing a POST somebody might otherwise think had been accepted.
      return new Response("The catalog is read-only", { status: 405 });
    }

    const url = new URL(req.url);
    const origin = url.origin;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/opds") {
      const scope = this.#userScope(req, origin);
      return scope ? this.#root(scope) : unauthorized();
    }

    const device = path.match(/^\/opds\/d\/([^/]+)(\/.*)?$/);
    if (device) {
      const scope = this.#deviceScope(req, decodeURIComponent(device[1]), origin);
      if (!scope) return unauthorized();
      return await this.#dispatch(req, scope, device[2] ?? "");
    }

    if (path.startsWith("/opds/")) {
      const scope = this.#userScope(req, origin);
      if (!scope) return unauthorized();
      return await this.#dispatch(req, scope, path.slice("/opds".length));
    }

    return notFound();
  };

  /** Everything below a scope's base, which is identical for both scopes. */
  async #dispatch(req: Request, scope: Scope, rest: string): Promise<Response> {
    const url = new URL(req.url);

    if (rest === "" || rest === "/") return this.#root(scope);
    if (rest === "/opensearch.xml") return this.#openSearch(scope);

    if (rest === "/folders") return this.#folders(scope);

    const page = Math.max(0, Math.trunc(Number(url.searchParams.get("page")) || 0));

    // `/folder/<library>` and `/folder/<library>/<subfolder path>`, the second
    // percent-encoded whole so its own slashes stay inside one segment.
    const folder = rest.match(/^\/folder\/([^/]+)(?:\/([^/]*))?$/);
    if (folder) {
      const id = decodeURIComponent(folder[1]);
      const lib = this.config.current.libraries.find((l) => l.id === id);
      if (!lib) return notFound();
      const relDir = safeSegments(folder[2] ? decodeURIComponent(folder[2]) : "");
      return this.#folder(scope, lib, relDir, rest, page, url.searchParams.get("all") === "1");
    }

    if (rest === "/all") return this.#acquisition(scope, "All books", rest, page, {});
    if (rest === "/new") {
      return this.#acquisition(scope, "Recently added", rest, page, { recent: true });
    }
    const shelf = rest.match(/^\/shelf\/(reading|unread|finished)$/);
    if (shelf) {
      const filter = shelf[1] as ReadingFilter;
      return this.#acquisition(scope, SHELF_TITLES[filter], rest, page, { reading: filter });
    }

    if (rest === "/search") {
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
      return this.#acquisition(scope, q ? `Search: ${q}` : "Search", rest, page, { query: q });
    }

    const book = rest.match(/^\/book\/([^/]+)\.epub$/);
    if (book) return await this.#download(scope, decodeURIComponent(book[1]));

    const image = rest.match(/^\/(cover|thumb)\/([^/]+)$/);
    if (image) return await this.#cover(decodeURIComponent(image[2]));

    return notFound();
  }

  // --- feeds ---

  #root(scope: Scope): Response {
    const shelf = (title: string, summary: string, href: string) =>
      navEntry(scope, title, summary, href, ACQ_TYPE);
    return feed(NAV_TYPE, {
      id: scope.base,
      title: scope.title,
      base: scope.base,
      selfHref: scope.base,
      entries: [
        shelf("Recently added", "The most recently indexed books", "/new"),
        shelf("All books", "Everything on this shelf", "/all"),
        shelf("Currently reading", "Started but not finished", "/shelf/reading"),
        shelf("Unread", "Never opened", "/shelf/unread"),
        shelf("Finished", "Read to the end", "/shelf/finished"),
        navEntry(scope, "Folders", "Browse by watched folder", "/folders", NAV_TYPE),
      ],
    });
  }

  /** Every watched folder, whether or not the reader asking syncs it — see
   * `#deviceScope()`. */
  #folders(scope: Scope): Response {
    const libraries = this.config.current.libraries;
    return feed(NAV_TYPE, {
      id: `${scope.base}/folders`,
      title: "Folders",
      base: scope.base,
      selfHref: `${scope.base}/folders`,
      // The type has to say which kind of feed the entry actually leads to —
      // some readers refuse to open an entry whose type does not match — and a
      // watched folder leads to navigation or straight to books depending on
      // whether it has subfolders.
      entries: libraries.map((l) =>
        navEntry(
          scope,
          l.name,
          "",
          `/folder/${encodeURIComponent(l.id)}`,
          this.#subfolders(l, []).length ? NAV_TYPE : ACQ_TYPE,
        )
      ),
    });
  }

  /**
   * One watched folder, browsable exactly as it sits on disk.
   *
   * The sync engine already mirrors that structure onto a reader
   * (`placementsFor()`), so a catalog that flattened it would be the only place
   * the arrangement stopped being true. Both read the same evidence — the
   * source path of each book — through `relativeDirSegments()`.
   *
   * A folder with subfolders answers with a **navigation** feed: its subfolders,
   * then "All books in …", which lists everything below it recursively. The
   * aggregate matters — it is what keeps every book reachable by browsing on a
   * client that renders only acquisition entries, and it is what this feed did
   * before there were subfolders at all. A folder with no subfolders skips
   * straight to the books, because an intermediate page offering one choice is
   * just a page.
   */
  #folder(
    scope: Scope,
    lib: { id: string; name: string; path: string },
    relDir: string[],
    self: string,
    page: number,
    all: boolean,
  ): Response {
    const here = relDir.length ? [lib.name, ...relDir].join(" / ") : lib.name;
    const prefix = `${lib.path.replace(/\\/g, "/").replace(/\/+$/, "")}/${
      relDir.length ? `${relDir.join("/")}/` : ""
    }`;
    const subfolders = this.#subfolders(lib, relDir);

    if (all || !subfolders.length) {
      return this.#acquisition(scope, here, self, page, {
        libraryId: lib.id,
        pathPrefix: prefix,
        all,
      });
    }

    const dirHref = (segs: string[]) =>
      `/folder/${encodeURIComponent(lib.id)}${
        segs.length ? `/${encodeURIComponent(segs.join("/"))}` : ""
      }`;

    return feed(NAV_TYPE, {
      id: `${scope.base}${self}`,
      title: here,
      base: scope.base,
      selfHref: `${scope.base}${self}`,
      entries: [
        ...subfolders.map((sub) =>
          navEntry(
            scope,
            sub.name,
            `${sub.books} book${sub.books === 1 ? "" : "s"}`,
            dirHref([...relDir, sub.name]),
            NAV_TYPE,
          )
        ),
        navEntry(
          scope,
          `All books in ${relDir.at(-1) ?? lib.name}`,
          "Everything in this folder, including its subfolders",
          `${dirHref(relDir)}?all=1`,
          ACQ_TYPE,
        ),
      ],
    });
  }

  /**
   * The immediate subfolders of `relDir`, and how many books sit anywhere below
   * each — derived from where the books are, so a folder exists here only while
   * it still holds something. Depth is deliberately uncapped, unlike the device
   * layout, which truncates at `MIRROR_MAX_DEPTH` for the firmware's sake:
   * browsing has no round trips to pay for and no reason to hide a level.
   */
  #subfolders(
    lib: { id: string; path: string },
    relDir: string[],
  ): { name: string; books: number }[] {
    const counts = new Map<string, number>();
    for (const path of this.books.pathsIn(lib.id)) {
      const segs = relativeDirSegments(path, lib.path, Infinity);
      if (segs.length <= relDir.length) continue;
      if (!relDir.every((seg, i) => segs[i] === seg)) continue;
      const name = segs[relDir.length];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts]
      .map(([name, books]) => ({ name, books }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  #openSearch(scope: Scope): Response {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${esc(scope.title)}</ShortName>
  <Description>Search the Pocket Sync library</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <OutputEncoding>UTF-8</OutputEncoding>
  <Url type="${esc(ACQ_TYPE)}" template="${esc(scope.base)}/search?q={searchTerms}"/>
</OpenSearchDescription>
`;
    return xmlResponse(xml, "application/opensearchdescription+xml");
  }

  /**
   * One page of books. Asks for one row more than fits so "is there a next
   * page" is answered without a second count query.
   */
  #acquisition(
    scope: Scope,
    title: string,
    self: string,
    page: number,
    q: {
      libraryId?: string;
      reading?: ReadingFilter;
      query?: string;
      recent?: boolean;
      pathPrefix?: string;
      /** Set on a folder's "All books" feed, which has to stay `all=1` across
       * its own paging or page 2 lands back on the folder's subfolder list. */
      all?: boolean;
    },
  ): Response {
    // One book per row whichever scope is asking: `Books.list` collapses a file
    // held by two folders into one row (invariant 7), so paging can stay in SQL.
    let rows = this.books.list({
      userId: scope.userId ?? undefined,
      libraryId: q.libraryId,
      pathPrefix: q.pathPrefix,
      reading: q.reading,
      query: q.query,
      limit: PAGE_SIZE + 1,
      offset: page * PAGE_SIZE,
    });

    if (q.recent) {
      rows = [...rows].sort((a, b) => b.added_at.localeCompare(a.added_at));
    }

    const hasNext = rows.length > PAGE_SIZE;
    const shown = hasNext ? rows.slice(0, PAGE_SIZE) : rows;

    // The query has to survive paging, or page 2 of a search is page 2 of
    // everything.
    const params = new URLSearchParams();
    if (q.query) params.set("q", q.query);
    if (q.all) params.set("all", "1");
    const href = (n: number) => {
      const p = new URLSearchParams(params);
      if (n > 0) p.set("page", String(n));
      const qs = p.toString();
      return `${scope.base}${self}${qs ? `?${qs}` : ""}`;
    };

    const links: string[] = [];
    if (hasNext) links.push(link("next", ACQ_TYPE, href(page + 1)));
    if (page > 0) links.push(link("previous", ACQ_TYPE, href(page - 1)));

    return feed(ACQ_TYPE, {
      id: href(page),
      title,
      base: scope.base,
      selfHref: href(page),
      extraLinks: links,
      entries: shown.map((b) => this.#bookEntry(scope, b)),
    });
  }

  #bookEntry(scope: Scope, book: LibraryRow): string {
    const id = encodeURIComponent(book.id);
    const summary = [
      book.series ? `${book.series}${book.series_index ? ` #${book.series_index}` : ""}` : "",
      book.finished
        ? "Finished"
        : book.percentage > 0
        ? `${Math.round(book.percentage * 100)}% read`
        : "",
    ].filter(Boolean).join(" · ");

    return `  <entry>
    <title>${esc(book.title)}</title>
    <id>urn:md5:${esc(book.id)}</id>
    <updated>${esc(iso(book.added_at))}</updated>
    <author><name>${esc(book.author)}</name></author>
${summary ? `    <summary>${esc(summary)}</summary>\n` : ""}${
      book.series ? `    <dc:source>${esc(book.series)}</dc:source>\n` : ""
    }    <dc:identifier>urn:md5:${esc(book.id)}</dc:identifier>
    <link rel="${ACQUISITION_REL}" type="application/epub+zip" href="${
      esc(`${scope.base}/book/${id}.epub`)
    }"/>
${
      book.cover_path
        ? `    <link rel="${IMAGE_REL}" type="image/jpeg" href="${
          esc(`${scope.base}/cover/${id}`)
        }"/>\n    <link rel="${THUMB_REL}" type="image/jpeg" href="${
          esc(`${scope.base}/thumb/${id}`)
        }"/>\n`
        : ""
    }  </entry>`;
  }

  // --- bytes ---

  async #download(scope: Scope, bookId: string): Promise<Response> {
    const book = this.books.get(bookId);
    if (!book?.epub_path) return notFound();

    let path: string;
    try {
      // The same preparation the upload path performs — resampled for this
      // device, stamped, and its document hashes recorded. See the note at the
      // top of the file: skipping any of it makes the pulled copy unattributable.
      path = (await this.sync.prepareForDevice(book, scope.deviceId, scope.profile)).path;
    } catch (err) {
      this.log.error(
        "opds.prepare.failed",
        `Could not prepare “${book.title}” for download: ${err}`,
        {
          deviceId: scope.deviceId ?? undefined,
          bookId: book.id,
        },
      );
      return new Response("Could not prepare this book", { status: 500 });
    }

    let file: Deno.FsFile;
    let size: number;
    try {
      file = await Deno.open(path, { read: true });
      size = (await file.stat()).size;
    } catch {
      return notFound();
    }

    this.log.info(
      "opds.download",
      `Served “${book.title}” to ${scope.deviceId ? scope.title : "an OPDS client"}` +
        `${scope.profile ? ` (${scope.profile.name})` : " unoptimized"}`,
      { deviceId: scope.deviceId ?? undefined, bookId: book.id },
    );

    return new Response(file.readable, {
      headers: {
        "content-type": "application/epub+zip",
        "content-length": String(size),
        "content-disposition": `attachment; filename="${asciiFilename(book)}"`,
      },
    });
  }

  async #cover(bookId: string): Promise<Response> {
    const book = this.books.get(bookId);
    if (!book?.cover_path) return notFound();
    try {
      const bytes = await Deno.readFile(book.cover_path);
      return new Response(bytes, {
        headers: { "content-type": "image/jpeg", "cache-control": "max-age=86400" },
      });
    } catch {
      return notFound();
    }
  }

  // --- lifecycle (mirrors KosyncServer: its own listener, rebound on change) ---

  async applyConfig(): Promise<void> {
    const { enabled, port, host } = this.config.current.opds;
    if (this.#at?.port === port && this.#at.host === host && enabled === !!this.#server) return;
    await this.stop();
    if (!enabled) {
      this.log.info("opds.stopped", "The OPDS catalog is off");
      return;
    }
    try {
      this.#server = Deno.serve({
        port,
        hostname: host,
        onListen: ({ hostname, port }) =>
          this.log.info(
            "opds.listen",
            `OPDS catalog on http://${hostname}:${port}/opds — anything that can reach this ` +
              `port can download the library`,
          ),
      }, this.handler);
      this.#at = { port, host };
    } catch (err) {
      this.#at = null;
      this.log.error(
        "opds.listen.failed",
        `Could not start the OPDS catalog on ${host}:${port} — ${err}`,
      );
    }
  }

  async stop() {
    await this.#server?.shutdown();
    this.#server = null;
    this.#at = null;
  }
}

const SHELF_TITLES: Record<string, string> = {
  reading: "Currently reading",
  unread: "Unread",
  finished: "Finished",
};

/** `type` is what tells the client whether following this link lands on more
 * navigation or on a list of books — getting it wrong makes some readers refuse
 * to open the entry at all. */
function navEntry(
  scope: Scope,
  title: string,
  summary: string,
  href: string,
  type: string,
): string {
  const url = `${scope.base}${href}`;
  return `  <entry>
    <title>${esc(title)}</title>
    <id>${esc(url)}</id>
    <updated>${new Date().toISOString()}</updated>
${
    summary
      ? `    <content type="text">${esc(summary)}</content>\n`
      : ""
  }    <link rel="subsection" type="${esc(type)}" href="${esc(url)}"/>
  </entry>`;
}

function link(rel: string, type: string, href: string): string {
  return `  <link rel="${esc(rel)}" type="${esc(type)}" href="${esc(href)}"/>`;
}

function feed(
  contentType: string,
  f: {
    id: string;
    title: string;
    base: string;
    selfHref: string;
    entries: string[];
    extraLinks?: string[];
  },
): Response {
  const lines = [
    link("self", contentType, f.selfHref),
    link("start", NAV_TYPE, f.base),
    link("search", "application/opensearchdescription+xml", `${f.base}/opensearch.xml`),
    ...(f.extraLinks ?? []),
    ...f.entries,
  ];
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="${ATOM}" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${esc(f.id)}</id>
  <title>${esc(f.title)}</title>
  <updated>${new Date().toISOString()}</updated>
  <author><name>Pocket Sync</name></author>
${lines.join("\n")}
</feed>
`;
  return xmlResponse(xml, contentType);
}

function xmlResponse(xml: string, contentType: string): Response {
  return new Response(xml, {
    headers: { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-cache" },
  });
}

/** Atom is XML: a title containing `&` or `<` is not a rendering nuisance, it
 * is a feed the client refuses to parse at all. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Atom demands RFC 3339. Rows written before that was enforced can hold
 * anything, so an unparseable date becomes the epoch rather than invalid XML. */
function iso(value: string): string {
  const t = Date.parse(value);
  return new Date(Number.isNaN(t) ? 0 : t).toISOString();
}

/** `Content-Disposition` is header-encoded, so the readable name is reduced to
 * ASCII rather than escaped — the identity the device needs is in the OPF. */
export function asciiFilename(book: Pick<Book, "id" | "title" | "author">): string {
  const base = `${book.title} - ${book.author}`
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // A title with no ASCII in it at all reduces to the punctuation between the
  // fields — "-" is not a filename, so fall back to the id rather than to
  // whatever survived the strip.
  return `${/[A-Za-z0-9]/.test(base) ? base : book.id}.epub`;
}

/**
 * A folder path from a URL, reduced to plain names.
 *
 * Nothing here ever opens a file — a subfolder is only matched against paths
 * already in the index — but `..` and empty segments would still be a way to
 * ask for a folder that cannot exist, and dropping them means such a request
 * lands on the parent rather than on something surprising.
 */
export function safeSegments(rel: string): string[] {
  return rel
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..");
}

const notFound = () => new Response("Not found", { status: 404 });

/** `WWW-Authenticate` so a client that guessed a username wrong gets a prompt
 * rather than a dead end. The password is still ignored. */
const unauthorized = () =>
  new Response("Unknown user", {
    status: 401,
    headers: { "www-authenticate": `Basic realm="Pocket Sync"` },
  });
