/** Filesystem layout for the app data directory (§12 of the brief). */

/** Per-OS application data directory. */
export function defaultDataDir(): string {
  const override = Deno.env.get("POCKET_DATA_DIR");
  if (override) return override;

  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA") ??
      `${Deno.env.get("USERPROFILE") ?? "."}/AppData/Roaming`;
    return `${appData.replace(/\\/g, "/")}/pocket-sync`;
  }
  const home = Deno.env.get("HOME") ?? ".";
  if (Deno.build.os === "darwin") return `${home}/Library/Application Support/pocket-sync`;
  const xdg = Deno.env.get("XDG_DATA_HOME") || `${home}/.local/share`;
  return `${xdg}/pocket-sync`;
}

/** Directory containing the app source / bundle resources. */
export function appRoot(): string {
  // src/core/paths.ts -> repo root
  return new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
}

export class Paths {
  constructor(readonly dataDir: string) {}

  get db() {
    return `${this.dataDir}/db.sqlite`;
  }
  get configFile() {
    return `${this.dataDir}/config.json`;
  }
  get libraryDir() {
    return `${this.dataDir}/library`;
  }
  get logsDir() {
    return `${this.dataDir}/logs`;
  }
  get logFile() {
    return `${this.logsDir}/pocket-sync.log`;
  }
  get tmpDir() {
    return `${this.dataDir}/tmp`;
  }
  /** Where the Python sidecar and its bundled interpreter are materialized. */
  get engineDir() {
    return `${this.dataDir}/engine`;
  }
  get pythonDir() {
    return `${this.engineDir}/python`;
  }

  bookDir(bookId: string) {
    return `${this.libraryDir}/${bookId}`;
  }
  original(bookId: string, ext: string) {
    return `${this.bookDir(bookId)}/original.${ext.replace(/^\./, "")}`;
  }
  epub(bookId: string) {
    return `${this.bookDir(bookId)}/book.epub`;
  }
  cover(bookId: string) {
    return `${this.bookDir(bookId)}/cover.jpg`;
  }
  optimized(bookId: string, profileHash: string) {
    return `${this.bookDir(bookId)}/opt-${profileHash}.epub`;
  }

  ensure() {
    for (const d of [this.dataDir, this.libraryDir, this.logsDir, this.tmpDir]) {
      Deno.mkdirSync(d, { recursive: true });
    }
  }
}
