import type { AppEvent, EventBus, LogLevel } from "./events.ts";
import type { Paths } from "./paths.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

export interface LogFields {
  deviceId?: string;
  bookId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Structured logger: every call fans out to the rotating JSONL file, the
 * in-memory event bus (web UI + tray) and stderr.
 */
export class Logger {
  #minLevel: LogLevel = "info";
  #file: Deno.FsFile | null = null;
  #bytes = 0;

  constructor(readonly paths: Paths, readonly bus: EventBus) {}

  setLevel(level: LogLevel) {
    this.#minLevel = level;
  }

  debug = (event: string, message: string, f?: LogFields) => this.log("debug", event, message, f);
  info = (event: string, message: string, f?: LogFields) => this.log("info", event, message, f);
  warn = (event: string, message: string, f?: LogFields) => this.log("warn", event, message, f);
  error = (event: string, message: string, f?: LogFields) => this.log("error", event, message, f);

  log(level: LogLevel, event: string, message: string, fields: LogFields = {}): AppEvent | null {
    if (ORDER[level] < ORDER[this.#minLevel]) return null;
    const e = this.bus.emit({ level, event, message, ...fields });
    this.#writeLine(e);
    const line = `${e.ts} ${level.toUpperCase().padEnd(5)} ${event} — ${message}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
    return e;
  }

  #writeLine(e: AppEvent) {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(e) + "\n");
      if (!this.#file) {
        this.#file = Deno.openSync(this.paths.logFile, { create: true, append: true });
        this.#bytes = Deno.statSync(this.paths.logFile).size;
      }
      this.#file.writeSync(bytes);
      this.#bytes += bytes.length;
      if (this.#bytes > MAX_BYTES) this.#rotate();
    } catch (err) {
      console.error("log write failed", err);
    }
  }

  #rotate() {
    this.#file?.close();
    this.#file = null;
    this.#bytes = 0;
    try {
      for (let i = KEEP - 1; i >= 1; i--) {
        try {
          Deno.renameSync(`${this.paths.logFile}.${i}`, `${this.paths.logFile}.${i + 1}`);
        } catch { /* no such rotation yet */ }
      }
      Deno.renameSync(this.paths.logFile, `${this.paths.logFile}.1`);
    } catch (err) {
      console.error("log rotate failed", err);
    }
  }

  /** Tail of the on-disk log, newest last. */
  async tail(limit = 500): Promise<AppEvent[]> {
    try {
      const text = await Deno.readTextFile(this.paths.logFile);
      const lines = text.trimEnd().split("\n").slice(-limit);
      return lines.flatMap((l) => {
        try {
          return [JSON.parse(l) as AppEvent];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  close() {
    this.#file?.close();
    this.#file = null;
  }
}
