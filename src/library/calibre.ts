import type { Config } from "../core/config.ts";
import { type DedrmState, dedrmState, parsePluginList, staleDrmPlugins } from "./dedrm.ts";

export interface BookMetadata {
  title?: string;
  author?: string;
  series?: string;
  seriesIndex?: number;
  languages?: string;
  publisher?: string;
  comments?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], timeoutMs = 10 * 60_000): Promise<RunResult> {
  const child = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);
  try {
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The Calibre CLI tools we drive. */
export type CalibreTool =
  | "ebook-convert"
  | "ebook-meta"
  | "calibredb"
  | "calibre-customize"
  | "calibre-debug"
  | "fetch-ebook-metadata";

/** Where Calibre normally lives, per OS. A bare name means "search PATH". */
export function calibreCandidates(tool: CalibreTool): string[] {
  switch (Deno.build.os) {
    case "darwin":
      return [
        `/Applications/calibre.app/Contents/MacOS/${tool}`,
        `${Deno.env.get("HOME") ?? ""}/Applications/calibre.app/Contents/MacOS/${tool}`,
        tool,
      ];
    case "windows":
      return [
        `C:/Program Files/Calibre2/${tool}.exe`,
        `C:/Program Files (x86)/Calibre2/${tool}.exe`,
        `${Deno.env.get("LOCALAPPDATA") ?? ""}/Programs/Calibre2/${tool}.exe`,
        `${tool}.exe`,
      ];
    default:
      return [
        `/usr/bin/${tool}`,
        `/usr/local/bin/${tool}`,
        `/opt/calibre/${tool}`,
        `${Deno.env.get("HOME") ?? ""}/.local/bin/${tool}`,
        `/var/lib/flatpak/exports/bin/com.calibre_ebook.calibre.${tool}`,
        tool,
      ];
  }
}

export interface CalibreStatus {
  convert: boolean;
  meta: boolean;
  /** `calibredb` is what runs file-type plugins, i.e. DRM removal. */
  db: boolean;
  /** Is DeDRM installed *and* enabled? The only flag callers should branch on. */
  dedrm: boolean;
  /** Installed but switched off — a different problem with a different fix. */
  dedrmDisabled: boolean;
  /**
   * Superseded DRM plugins that no longer load. Worth surfacing: they are why
   * `--list-plugins` mentions DeDRM on a machine that has no working copy of it.
   */
  stalePlugins: string[];
  version?: string;
  convertPath?: string;
  metaPath?: string;
}

export class Calibre {
  #resolved = new Map<CalibreTool, string>();

  constructor(private readonly cfg: () => Config) {}

  /**
   * Resolve a tool: the configured path wins, otherwise the usual install
   * locations are probed. Resolution is cached until `forget()`.
   */
  async resolve(tool: CalibreTool): Promise<string | null> {
    const cached = this.#resolved.get(tool);
    if (cached) return cached;

    const configured = tool === "ebook-convert"
      ? this.cfg().calibrePath
      : tool === "ebook-meta"
      ? this.cfg().ebookMetaPath
      : "";
    const candidates = [configured, ...calibreCandidates(tool)].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (await runs(candidate)) {
        this.#resolved.set(tool, candidate);
        return candidate;
      }
    }
    return null;
  }

  /** Drop cached resolutions (after the user edits the path in Settings). */
  forget() {
    this.#resolved.clear();
  }

  /** Which of the CLI tools we depend on are present and runnable? */
  async check(): Promise<CalibreStatus> {
    this.forget();
    const [convertPath, metaPath, dbPath] = await Promise.all([
      this.resolve("ebook-convert"),
      this.resolve("ebook-meta"),
      this.resolve("calibredb"),
    ]);
    const plugins = await this.listPlugins();
    const state = plugins ? dedrmState(plugins) : "missing";
    const out: CalibreStatus = {
      convert: !!convertPath,
      meta: !!metaPath,
      db: !!dbPath,
      dedrm: state === "ok",
      dedrmDisabled: state === "disabled",
      stalePlugins: plugins ? staleDrmPlugins(plugins) : [],
      convertPath: convertPath ?? undefined,
      metaPath: metaPath ?? undefined,
    };
    if (convertPath) {
      try {
        out.version = (await run(convertPath, ["--version"], 30_000)).stdout.trim().split("\n")[0];
      } catch { /* reported by the flags above */ }
    }
    return out;
  }

  /** Convert any Calibre-supported input to EPUB. Throws on failure. */
  async toEpub(input: string, output: string): Promise<RunResult> {
    const bin = await this.resolve("ebook-convert");
    if (!bin) {
      throw new Error(
        "Calibre's ebook-convert was not found. Install Calibre (calibre-ebook.com) to add " +
          "non-EPUB formats, or set its path in Settings.",
      );
    }
    const r = await run(bin, [input, output]);
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split("\n").slice(-6).join("\n");
      throw new Error(`ebook-convert failed (exit ${r.code}): ${tail}`);
    }
    return r;
  }

  /**
   * The installed plugins, or null when Calibre is not available.
   *
   * Parsed rather than grepped. Calibre prints plugin *load failures* on stdout
   * before the table, so a machine carrying the superseded "Inept Epub DeDRM"
   * plugins matches a naive `/dedrm/i` search and reads as fully set up, when in
   * fact nothing can decrypt anything.
   */
  async listPlugins(): Promise<ReturnType<typeof parsePluginList> | null> {
    const bin = await this.resolve("calibre-customize");
    if (!bin) return null;
    try {
      return parsePluginList((await run(bin, ["--list-plugins"], 60_000)).stdout);
    } catch {
      return null;
    }
  }

  /** Is DeDRM installed, and is it switched on? */
  async dedrm(): Promise<DedrmState> {
    const plugins = await this.listPlugins();
    return plugins ? dedrmState(plugins) : "missing";
  }

  /**
   * Calibre's configuration directory — where DeDRM keeps its keys. Asking
   * Calibre beats reproducing its per-OS rules, and it honours
   * `CALIBRE_CONFIG_DIRECTORY` if the user has set one.
   */
  async configDir(): Promise<string | null> {
    const bin = await this.resolve("calibre-debug");
    if (!bin) return null;
    try {
      const r = await run(bin, [
        "-c",
        "from calibre.constants import config_dir; print(config_dir)",
      ], 60_000);
      if (r.code !== 0) return null;
      // Plugin load failures print first, so the path is the last thing said.
      const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      return lines.pop() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Remove a plugin by name. Verified by re-listing rather than by exit code:
   * the name is inferred from the zip's filename, and Calibre exits 0 when
   * asked to remove something it has never heard of.
   */
  async removePlugin(name: string): Promise<void> {
    const bin = await this.resolve("calibre-customize");
    if (!bin) throw new Error("Calibre's calibre-customize was not found.");
    await run(bin, ["--remove-plugin", name], 60_000);
    const after = await this.listPlugins();
    if (after && [...after.failed, ...after.plugins.map((p) => p.name)].includes(name)) {
      throw new Error(`Calibre still lists “${name}” — remove it from Preferences → Plugins.`);
    }
  }

  /**
   * Install a Calibre plugin zip. We fetch the release at the user's request
   * rather than bundling it — the plugin has to land in Calibre's config
   * directory either way, so shipping it would save a download and nothing else
   * (docs/DESIGN.md).
   */
  async installPlugin(zipPath: string): Promise<RunResult> {
    const bin = await this.resolve("calibre-customize");
    if (!bin) throw new Error("Calibre's calibre-customize was not found.");
    const r = await run(bin, ["--add-plugin", zipPath], 120_000);
    if (r.code !== 0) {
      throw new Error(
        `calibre-customize failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
      );
    }
    this.forget();
    return r;
  }

  /**
   * Import through `calibredb add`, which is the only path that runs Calibre's
   * file-type plugins — and therefore the only way DeDRM sees the file.
   * `ebook-convert` bypasses them entirely.
   *
   * Uses a throwaway library so the user's own Calibre library is never
   * touched, and returns the cleaned file.
   */
  async importWithPlugins(input: string, scratchDir: string): Promise<string> {
    const bin = await this.resolve("calibredb");
    if (!bin) {
      throw new Error(
        "Calibre's calibredb was not found. Install Calibre (calibre-ebook.com) to import " +
          "DRM-protected books.",
      );
    }
    const libDir = `${scratchDir}/lib`;
    const outDir = `${scratchDir}/out`;
    await Deno.mkdir(libDir, { recursive: true });
    await Deno.mkdir(outDir, { recursive: true });

    const added = await run(bin, [
      "add",
      input,
      `--with-library=${libDir}`,
    ]);
    if (added.code !== 0) {
      throw new Error(
        `calibredb add failed (exit ${added.code}): ${
          (added.stderr || added.stdout).trim().split("\n").slice(-4).join("\n")
        }`,
      );
    }

    const ids = /Added book ids:\s*([\d,\s]+)/i.exec(added.stdout)?.[1];
    const bookId = ids?.split(/[,\s]+/).filter(Boolean)[0];
    if (!bookId) {
      throw new Error(
        "Calibre imported the file but reported no book id — it may still be DRM-protected. " +
          "Check that your key is configured in Calibre's DeDRM plugin. " +
          // DeDRM reports why it failed on stdout while still exiting 0, so
          // callers can only tell "no key" from "unsupported format" if the
          // output travels with the error.
          (added.stdout + added.stderr).trim().split("\n").slice(-6).join(" "),
      );
    }

    const exported = await run(bin, [
      "export",
      bookId,
      `--with-library=${libDir}`,
      `--to-dir=${outDir}`,
      "--single-dir",
      "--dont-write-opf",
      "--dont-save-cover",
      "--template={title}",
    ]);
    if (exported.code !== 0) {
      throw new Error(
        `calibredb export failed (exit ${exported.code}): ${exported.stderr.trim()} ` +
          // Carry the add step's output too: a book that failed to decrypt says
          // so there, and that is the fact the caller needs to classify this.
          (added.stdout + added.stderr).trim().split("\n").slice(-6).join(" "),
      );
    }

    for await (const entry of Deno.readDir(outDir)) {
      if (entry.isFile) return `${outDir}/${entry.name}`;
    }
    throw new Error("Calibre exported nothing for this book");
  }

  /**
   * Fetch metadata and a cover from Calibre's online sources. Best effort — a
   * miss just leaves what the file itself declared.
   */
  async fetchMetadata(
    title: string,
    author: string,
    coverOut?: string,
  ): Promise<BookMetadata> {
    const bin = await this.resolve("fetch-ebook-metadata");
    if (!bin) return {};
    const args = ["--title", title];
    if (author && author !== "Unknown") args.push("--authors", author);
    if (coverOut) args.push("--cover", coverOut);
    try {
      const r = await run(bin, args, 120_000);
      if (r.code !== 0) return {};
      return parseMetaOutput(r.stdout);
    } catch {
      return {};
    }
  }

  /**
   * Read metadata via `ebook-meta`. Also extracts the cover when `coverOut`
   * is given. Never throws — callers fall back to the filename.
   */
  async readMetadata(input: string, coverOut?: string): Promise<BookMetadata> {
    const bin = await this.resolve("ebook-meta");
    if (!bin) return {};
    const args = [input];
    if (coverOut) args.push("--get-cover", coverOut);
    let r: RunResult;
    try {
      r = await run(bin, args, 120_000);
    } catch {
      return {};
    }
    if (r.code !== 0) return {};
    return parseMetaOutput(r.stdout);
  }
}

/** Does this executable exist and answer `--version`? */
async function runs(path: string): Promise<boolean> {
  try {
    return (await run(path, ["--version"], 30_000)).code === 0;
  } catch {
    return false;
  }
}

/** Parse the `Field : value` block `ebook-meta` prints. */
export function parseMetaOutput(stdout: string): BookMetadata {
  const fields = new Map<string, string>();
  let lastKey: string | null = null;
  for (const line of stdout.split("\n")) {
    const m = /^([A-Za-z()#\/ .-]+?)\s{2,}:\s?(.*)$/.exec(line);
    if (m) {
      lastKey = m[1].trim().toLowerCase();
      fields.set(lastKey, m[2].trim());
    } else if (lastKey && line.startsWith(" ") && line.trim()) {
      fields.set(lastKey, `${fields.get(lastKey)} ${line.trim()}`.trim());
    }
  }

  const meta: BookMetadata = {};
  const title = fields.get("title");
  if (title && title !== "Unknown") meta.title = title;
  const author = fields.get("author(s)");
  if (author && author !== "Unknown") {
    // "Jane Doe [Doe, Jane]" -> "Jane Doe"
    meta.author = author.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  }
  const series = fields.get("series");
  if (series) {
    const sm = /^(.*?)(?:\s*#\s*([\d.]+))?$/.exec(series);
    if (sm) {
      meta.series = sm[1].trim() || undefined;
      if (sm[2]) meta.seriesIndex = Number(sm[2]);
    }
  }
  for (
    const [key, prop] of [
      ["languages", "languages"],
      ["publisher", "publisher"],
      ["comments", "comments"],
    ] as const
  ) {
    const v = fields.get(key);
    if (v) meta[prop] = v;
  }
  return meta;
}

/** Fallback title/author from a filename like "Author - Title.epub". */
export function metadataFromFilename(filename: string): BookMetadata {
  const stem = filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const m = /^(.{2,60}?)\s+-\s+(.{2,})$/.exec(stem);
  if (m) return { author: m[1].trim(), title: m[2].trim() };
  return { title: stem || filename };
}
