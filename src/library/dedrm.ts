/**
 * Reading and writing Calibre's DeDRM plugin state.
 *
 * Keys are still Calibre's: they live in its config directory, anything already
 * configured there keeps working, and we never own or copy one. What we add is
 * the ability to *append* a Kindle serial without making the user open Calibre's
 * GUI to do it — the one piece of setup that otherwise turns importing a
 * protected book into a two-application chore (docs/DESIGN.md).
 *
 * Nothing here is persisted on our side. A serial is written straight into
 * DeDRM's own `dedrm.json` and read back from it, so `config.json` and the
 * database never hold key material — which also keeps serials out of
 * `GET /api/settings`, which is not loopback-gated.
 *
 * The parsers are deliberately pure and exported: the test suite never spawns a
 * subprocess, so anything that has to be correct is tested against captured
 * output instead.
 */

/** One row of `calibre-customize --list-plugins`. */
export interface PluginRow {
  type: string;
  name: string;
  version: string;
  disabled: boolean;
}

export interface PluginList {
  plugins: PluginRow[];
  /**
   * Plugins Calibre could not load, by name. These are printed *before* the
   * table and on **stdout**, which is why a naive `/dedrm/i` grep over the whole
   * output reports a working DeDRM when all that exists is a broken one.
   */
  failed: string[];
}

const HEADER = /^Type\s{2,}Name\s{2,}Version\s{2,}Disabled/;
const FAILED = /^Failed to initialize plugin:\s*'(.+)'\s*$/;

/**
 * Parse `calibre-customize --list-plugins`.
 *
 * The table is fixed-width with at least two spaces between columns; a plugin's
 * description follows its row on TAB-indented continuation lines. Everything
 * before the header is preamble, not data.
 */
export function parsePluginList(stdout: string): PluginList {
  const plugins: PluginRow[] = [];
  const failed: string[] = [];
  let seenHeader = false;

  for (const line of stdout.split("\n")) {
    const fail = FAILED.exec(line.trim());
    if (fail) {
      // Calibre names a plugin's zip after the plugin, so the basename is the
      // name `--remove-plugin` expects. It is a guess, which is why removal
      // verifies by re-listing rather than trusting its own exit code.
      const base = fail[1].replace(/\\/g, "/").split("/").pop() ?? "";
      failed.push(base.replace(/\.zip$/i, ""));
      continue;
    }
    if (!seenHeader) {
      if (HEADER.test(line)) seenHeader = true;
      continue;
    }
    // Blank separators, and TAB-indented description lines, are not rows.
    if (!line.trim() || /^\s/.test(line)) continue;

    const cells = line.trim().split(/\s{2,}/);
    if (cells.length < 4) continue;
    const [type, name, version, disabled] = cells;
    plugins.push({
      type: type.trim(),
      name: name.trim(),
      version: version.trim(),
      disabled: disabled.trim().toLowerCase() === "true",
    });
  }

  return { plugins, failed };
}

/** Upstream's `PLUGIN_NAME`, and the only name that counts as the real thing. */
const DEDRM_NAME = "DeDRM";

export type DedrmState = "ok" | "disabled" | "missing";

/**
 * Is DeDRM installed and usable?
 *
 * `disabled` is kept distinct from `missing` because the fix differs — one is
 * `--enable-plugin`, the other a download — and because a disabled plugin
 * otherwise looks exactly like a missing one from the outside.
 */
export function dedrmState(list: PluginList): DedrmState {
  const row = list.plugins.find(
    (p) => p.name === DEDRM_NAME && p.type.toLowerCase() === "file type",
  );
  if (!row) return "missing";
  return row.disabled ? "disabled" : "ok";
}

/**
 * Superseded DRM plugins that no longer load. Scoped to DRM-related names on
 * purpose: a plugin failing to load is the user's business, and we should only
 * offer to remove the ones that are both obsolete and actively misleading here.
 */
export function staleDrmPlugins(list: PluginList): string[] {
  return list.failed.filter((name) => /dedrm|inept|ignoble/i.test(name));
}

export interface SerialCheck {
  serial?: string;
  error?: string;
}

/**
 * Validate a Kindle device serial.
 *
 * Sixteen alphanumeric characters, **case preserved** — DeDRM compares serials
 * case-sensitively, so normalising the case here would produce a key that
 * silently never matches.
 */
export function validSerial(raw: string): SerialCheck {
  const serial = raw.replace(/[\s-]/g, "");
  if (!serial) return { error: "Enter your Kindle's serial number." };
  if (!/^[A-Za-z0-9]+$/.test(serial)) {
    return { error: "A Kindle serial is letters and digits only." };
  }
  if (serial.length !== 16) {
    return {
      error: `A Kindle serial is 16 characters; that one is ${serial.length}. ` +
        "Find it on the reader under Settings → Device Info.",
    };
  }
  return { serial };
}

/** The subset of DeDRM's preferences we read. Every other key is preserved. */
interface Prefs {
  serials?: string[];
  kindlekeys?: Record<string, unknown>;
  adeptkeys?: Record<string, unknown>;
  androidkeys?: Record<string, unknown>;
  [key: string]: unknown;
}

/** What the UI shows about the user's key setup. Never includes a key value. */
export interface KeySummary {
  configDir: string;
  serials: string[];
  /** Keys DeDRM harvested itself from Adobe Digital Editions / Kindle for PC. */
  adobeKeys: number;
  kindleKeys: number;
}

/**
 * DeDRM's `plugins/dedrm.json`.
 *
 * The file does not exist until Calibre's config dialog is opened or a decrypt
 * runs, so "absent" is the normal first state and never an error. Writing a
 * partial file is safe and is what upstream's own CLI instructions tell people
 * to do: Calibre's `JSONConfig` falls back to the plugin's defaults for every
 * key we leave out.
 */
export class Dedrm {
  #dir: string | null = null;

  constructor(private readonly configDir: () => Promise<string | null>) {}

  /** Drop the cached config directory (after Calibre's path changes). */
  forget() {
    this.#dir = null;
  }

  async #prefsPath(): Promise<string> {
    if (!this.#dir) {
      const dir = await this.configDir();
      if (!dir) {
        throw new Error(
          "Could not find Calibre's configuration directory. Install Calibre " +
            "(calibre-ebook.com), or set its path in Settings.",
        );
      }
      this.#dir = dir;
    }
    return `${this.#dir}/plugins/dedrm.json`;
  }

  async #read(): Promise<Prefs> {
    const path = await this.#prefsPath();
    try {
      return JSON.parse(await Deno.readTextFile(path)) as Prefs;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return {};
      // A corrupt file is the user's, and silently overwriting it would throw
      // away keys we cannot regenerate.
      throw new Error(`Calibre's DeDRM settings could not be read (${path}): ${err}`);
    }
  }

  /** Read-modify-write, preserving every key we do not understand. */
  async #write(prefs: Prefs) {
    const path = await this.#prefsPath();
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, `${JSON.stringify(prefs, null, 2)}\n`);
  }

  async summary(): Promise<KeySummary> {
    const prefs = await this.#read();
    return {
      configDir: this.#dir ?? "",
      serials: prefs.serials ?? [],
      adobeKeys: Object.keys(prefs.adeptkeys ?? {}).length,
      kindleKeys: Object.keys(prefs.kindlekeys ?? {}).length,
    };
  }

  /** Append a serial. Returns false when it was already configured. */
  async addSerial(serial: string): Promise<boolean> {
    const prefs = await this.#read();
    const serials = prefs.serials ?? [];
    if (serials.includes(serial)) return false;
    prefs.serials = [...serials, serial];
    await this.#write(prefs);
    return true;
  }

  /** Remove a serial. Returns false when it was not there. */
  async removeSerial(serial: string): Promise<boolean> {
    const prefs = await this.#read();
    const serials = prefs.serials ?? [];
    if (!serials.includes(serial)) return false;
    prefs.serials = serials.filter((s) => s !== serial);
    await this.#write(prefs);
    return true;
  }
}
