/**
 * CrossInk/CrossPoint device HTTP API client (§8.2).
 *
 * Mirrors the request shapes `crosspoint_reader/driver.py` uses — those are
 * confirmed working against the firmware. The WebSocket upload and the UDP
 * discovery use the vendored `ws_client.py` through the engine sidecar
 * instead of being reimplemented here.
 */

export interface DeviceFile {
  name: string;
  isDirectory: boolean;
  isEpub: boolean;
  size: number;
}

export interface DeviceEpub {
  path: string;
  name: string;
  size: number;
}

export interface DeviceStatus {
  device?: string;
  [k: string]: unknown;
}

/**
 * The reader's own KOReader Sync client, as its settings page writes it.
 *
 * `koMatchMethod` is how the reader identifies a book to the sync server:
 * **1 = binary** (a hash of the file it holds), **0 = filename**.
 */
export interface DeviceKosyncSettings {
  koUsername: string;
  koPassword: string;
  koServerUrl: string;
  koMatchMethod: number;
}

/**
 * One OPDS catalog as the reader reports it. The reader is an OPDS *client*:
 * these are the shelves it can browse and pull books from itself.
 */
export interface DeviceOpdsCatalog {
  /** Slot number, and the handle for editing this entry in place. */
  index: number;
  name: string;
  url: string;
  username: string;
  /** `title_author` and `author_title` are both known good. */
  filenameFormat: string;
  /** Whether a password is stored — never the password itself. */
  hasPassword?: boolean;
}

export interface DeviceOpdsCatalogInput {
  name: string;
  url: string;
  username: string;
  filenameFormat: string;
  /** Omit on an edit to keep whatever is stored. */
  password?: string;
  /** Omit to append a new catalog; include to overwrite that slot. */
  index?: number;
}

/**
 * Reduce `/api/settings` to a flat `key → value` map.
 *
 * Firmware 1.4.0 answers with an array of descriptors —
 * `[{key, name, category, type, value, options?}, …]` — not the flat object the
 * settings *write* takes. An array is still `typeof "object"`, so reading a
 * field straight off the response silently yields `undefined` for every key,
 * which reads as "the reader kept nothing" and turns a successful write into a
 * reported failure. Both shapes are accepted because the flat one is what older
 * notes recorded and what the simulator used to send.
 */
export function flattenSettings(body: unknown): Record<string, unknown> | null {
  if (Array.isArray(body)) {
    const out: Record<string, unknown> = {};
    for (const row of body) {
      if (row && typeof row === "object" && typeof (row as { key?: unknown }).key === "string") {
        out[(row as { key: string }).key] = (row as { value?: unknown }).value;
      }
    }
    return out;
  }
  return body && typeof body === "object" ? body as Record<string, unknown> : null;
}

/** Device paths are forward-slash with a single leading slash. */
export function normalizeDevicePath(p: string): string {
  if (!p) return "";
  let out = p.replace(/\\/g, "/");
  while (out.includes("//")) out = out.replace(/\/\//g, "/");
  return out.startsWith("/") ? out : "/" + out;
}

export function joinDevicePath(dir: string, name: string): string {
  return normalizeDevicePath(dir === "/" ? `/${name}` : `${dir}/${name}`);
}

export class DeviceClient {
  /**
   * `host` may carry a non-default HTTP port ("192.168.1.50:8080"); the
   * firmware serves on port 80, so a bare address is the normal case.
   */
  constructor(
    readonly host: string,
    readonly wsPort = 81,
    private readonly timeoutMs = 8000,
  ) {}

  get base(): string {
    return `http://${this.host}`;
  }

  /** Address without any HTTP port — what the WebSocket upload connects to. */
  get hostname(): string {
    const m = /^\[(.+)\](?::\d+)?$/.exec(this.host); // [::1]:8099
    if (m) return m[1];
    return this.host.split(":")[0];
  }

  async #fetch(path: string, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetch(`${this.base}${path}`, { ...init, signal });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${init?.method ?? "GET"} ${path} -> HTTP ${res.status}`);
    }
    return res;
  }

  async status(timeoutMs = 4000): Promise<DeviceStatus> {
    const res = await this.#fetch("/api/status", undefined, timeoutMs);
    return await res.json() as DeviceStatus;
  }

  /** True if the device answers at all — used as the "connected" signal. */
  async reachable(timeoutMs = 3000): Promise<boolean> {
    try {
      await this.status(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The reader's current settings, or null if this firmware won't say.
   *
   * A probe, not a fetch: it exists so we can tell "already pointed at us" and
   * "pointed at somebody else's sync server" apart before writing, and every
   * caller has to work without it, because whether the endpoint reads as well
   * as writes is not something we can promise across firmware versions.
   */
  async settings(timeoutMs = 6000): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.#fetch("/api/settings", undefined, timeoutMs);
      return flattenSettings(await res.json());
    } catch {
      return null;
    }
  }

  /**
   * The OPDS catalogs this reader knows about.
   *
   * `index` is the slot, and it is how an entry is edited rather than
   * duplicated. `hasPassword` is a boolean, not the password: the firmware
   * never reads one back, so whether the stored password is still the one we
   * sent is not a question this endpoint can answer.
   */
  async opdsCatalogs(timeoutMs = 6000): Promise<DeviceOpdsCatalog[] | null> {
    try {
      const res = await this.#fetch("/api/opds", undefined, timeoutMs);
      const body = await res.json();
      return Array.isArray(body) ? body as DeviceOpdsCatalog[] : null;
    } catch {
      return null;
    }
  }

  /**
   * Add a catalog, or edit one in place.
   *
   * Include `index` to overwrite that slot, omit it to append — that is the
   * whole difference, and getting it wrong appends a duplicate on every sync.
   * Omitting `password` on an edit keeps the stored one.
   */
  async saveOpdsCatalog(entry: DeviceOpdsCatalogInput): Promise<void> {
    const res = await this.#fetch("/api/opds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }, 12_000);
    await res.body?.cancel();
  }

  /**
   * Write settings, as the reader's own web UI does: a JSON body carrying only
   * the fields being changed. Everything not named is left alone.
   */
  async writeSettings(patch: Record<string, unknown>): Promise<void> {
    const res = await this.#fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }, 12_000);
    await res.body?.cancel();
  }

  async listDir(path = "/"): Promise<DeviceFile[]> {
    const res = await this.#fetch(`/api/files?path=${encodeURIComponent(path)}`);
    const json = await res.json();
    return Array.isArray(json) ? json as DeviceFile[] : [];
  }

  /** Flat list of every EPUB on the device. */
  async listEpubs(path = "/", depth = 0): Promise<DeviceEpub[]> {
    if (depth > 8) return [];
    const out: DeviceEpub[] = [];
    for (const entry of await this.listDir(path)) {
      if (!entry.name) continue;
      const child = joinDevicePath(path, entry.name);
      if (entry.isDirectory) {
        out.push(...await this.listEpubs(child, depth + 1));
      } else if (entry.isEpub) {
        out.push({ path: child, name: entry.name, size: entry.size ?? 0 });
      }
    }
    return out;
  }

  /** POST /delete with form field `paths` = JSON array. */
  async delete(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const body = new URLSearchParams({
      paths: JSON.stringify(paths.map(normalizeDevicePath)),
    });
    const res = await this.#fetch("/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }, 15_000);
    await res.body?.cancel();
  }

  async dirExists(name: string, parent: string): Promise<boolean> {
    try {
      return (await this.listDir(parent)).some((e) => e.isDirectory && e.name === name);
    } catch {
      return false;
    }
  }

  /**
   * Create one directory level. Firmware returns 400 (or hangs) when the
   * folder already exists, so any error is re-checked against the listing.
   */
  async mkdir(name: string, parent: string): Promise<void> {
    const body = new URLSearchParams({ name, path: parent });
    try {
      const res = await this.#fetch("/mkdir", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }, 12_000);
      await res.body?.cancel();
    } catch (err) {
      if (!await this.dirExists(name, parent)) {
        throw new Error(`mkdir failed for ${name} in ${parent}: ${err}`);
      }
    }
  }

  /** Create nested directories one level at a time; returns the full path. */
  async ensureDir(parent: string, subdirs: string[]): Promise<string> {
    let current = normalizeDevicePath(parent);
    for (const sub of subdirs) {
      if (!sub) continue;
      if (!await this.dirExists(sub, current)) await this.mkdir(sub, current);
      current = joinDevicePath(current, sub);
    }
    return current;
  }

  /**
   * WebDAV upload — the firmware's secondary delivery path (§8.2). Used only
   * after the WebSocket transfer has exhausted its retries.
   */
  async putFile(devicePath: string, data: Uint8Array, timeoutMs = 120_000): Promise<void> {
    const res = await this.#fetch(normalizeDevicePath(devicePath), {
      method: "PUT",
      headers: { "content-type": "application/epub+zip" },
      // cast: node:sqlite pulls in Node's Uint8Array typings, which the DOM
      // BodyInit union doesn't structurally match.
      body: data as unknown as BodyInit,
    }, timeoutMs);
    await res.body?.cancel();
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.#fetch(`/download?path=${encodeURIComponent(path)}`, undefined, 60_000);
    return new Uint8Array(await res.arrayBuffer());
  }
}
