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
