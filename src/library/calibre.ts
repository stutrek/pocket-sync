import type { Config } from "../core/config.ts";

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

/** Where Calibre normally lives, per OS. A bare name means "search PATH". */
export function calibreCandidates(tool: "ebook-convert" | "ebook-meta"): string[] {
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
  version?: string;
  convertPath?: string;
  metaPath?: string;
}

export class Calibre {
  #convert: string | null = null;
  #meta: string | null = null;

  constructor(private readonly cfg: () => Config) {}

  /**
   * Resolve a tool: the configured path wins, otherwise the usual install
   * locations are probed. Resolution is cached until `forget()`.
   */
  async resolve(tool: "ebook-convert" | "ebook-meta"): Promise<string | null> {
    const cached = tool === "ebook-convert" ? this.#convert : this.#meta;
    if (cached) return cached;

    const configured = tool === "ebook-convert" ? this.cfg().calibrePath : this.cfg().ebookMetaPath;
    const candidates = [configured, ...calibreCandidates(tool)].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (await runs(candidate)) {
        if (tool === "ebook-convert") this.#convert = candidate;
        else this.#meta = candidate;
        return candidate;
      }
    }
    return null;
  }

  /** Drop cached resolutions (after the user edits the path in Settings). */
  forget() {
    this.#convert = null;
    this.#meta = null;
  }

  /** Are the two CLI tools we depend on present and runnable? */
  async check(): Promise<CalibreStatus> {
    this.forget();
    const [convertPath, metaPath] = await Promise.all([
      this.resolve("ebook-convert"),
      this.resolve("ebook-meta"),
    ]);
    const out: CalibreStatus = {
      convert: !!convertPath,
      meta: !!metaPath,
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
