import type { Config } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";
import { materializeEngine } from "./assets.ts";
import { ensurePythonRuntime } from "./runtime.ts";

export interface SidecarEvent {
  tag?: string;
  message?: string;
  sent?: number;
  total?: number;
  [k: string]: unknown;
}

export class SidecarError extends Error {
  constructor(message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "SidecarError";
  }
  /** True when an upload had already begun — the partial file needs deleting. */
  get uploadStarted(): boolean {
    return this.data.uploadStarted === true;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onEvent?: (e: SidecarEvent) => void;
}

/**
 * Supervises the Python engine process and speaks its JSON-lines protocol.
 * Commands run concurrently (the sidecar threads them); the process is
 * restarted lazily if it dies.
 */
export class Sidecar {
  #proc: Deno.ChildProcess | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #starting: Promise<void> | null = null;
  #lastStart = 0;
  #enc = new TextEncoder();
  #bundled: string | null = null;

  constructor(
    private readonly cfg: () => Config,
    private readonly paths: Paths,
    private readonly log: Logger,
  ) {}

  /**
   * Unpack the bundled interpreter if the app ships one. Safe to call twice;
   * a missing bundle just leaves us on a system interpreter.
   */
  async prepare(): Promise<void> {
    try {
      this.#bundled = await ensurePythonRuntime(this.paths, this.log);
    } catch (err) {
      this.log.error("runtime.failed", `Could not unpack the Python runtime: ${err}`);
      this.#bundled = null;
    }
  }

  /** Configured path, then the bundled runtime, then a dev venv, then PATH. */
  pythonPath(): string {
    const configured = this.cfg().pythonPath;
    if (configured && canExec(configured)) return configured;
    if (this.#bundled && canExec(this.#bundled)) return this.#bundled;
    const venv = Deno.build.os === "windows"
      ? `${this.paths.dataDir}/engine/.venv/Scripts/python.exe`
      : `${this.paths.dataDir}/engine/.venv/bin/python3`;
    if (canExec(venv)) return venv;
    return configured || (Deno.build.os === "windows" ? "python" : "python3");
  }

  /** True when running on the interpreter shipped inside the app. */
  get usingBundledPython(): boolean {
    return !!this.#bundled && this.pythonPath() === this.#bundled;
  }

  async #start(): Promise<void> {
    const since = Date.now() - this.#lastStart;
    if (since < 1000) await new Promise((r) => setTimeout(r, 1000 - since));
    this.#lastStart = Date.now();

    const { entry, updated } = materializeEngine(this.paths);
    if (updated) this.log.info("engine.updated", `Engine written to ${entry}`);

    const python = this.pythonPath();
    const proc = new Deno.Command(python, {
      args: ["-u", entry],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#proc = proc;
    this.#writer = proc.stdin.getWriter();
    this.log.debug("engine.started", `Engine sidecar started (${python})`);

    this.#readLines(proc.stdout, (line) => this.#handleLine(line));
    this.#readLines(proc.stderr, (line) => this.log.warn("engine.stderr", line));

    proc.status.then((status) => {
      const err = new Error(`engine sidecar exited (code ${status.code})`);
      for (const [, p] of this.#pending) p.reject(err);
      this.#pending.clear();
      if (this.#proc === proc) {
        this.#proc = null;
        this.#writer = null;
      }
      this.log.warn("engine.exited", `Engine sidecar exited with code ${status.code}`);
    });
  }

  async #ensure(): Promise<void> {
    if (this.#proc) return;
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null;
      });
    }
    await this.#starting;
  }

  #readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    (async () => {
      const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) onLine(line);
          }
        }
      } catch (err) {
        this.log.debug("engine.stream", `stream ended: ${err}`);
      }
    })();
  }

  #handleLine(line: string) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn("engine.badline", `Unparseable engine output: ${line.slice(0, 200)}`);
      return;
    }
    const id = msg.id as number | undefined;
    if (id === undefined) return; // "ready" banner and unsolicited errors
    const pending = this.#pending.get(id);
    if (!pending) return;
    switch (msg.type) {
      case "event":
        pending.onEvent?.(msg as SidecarEvent);
        break;
      case "result":
        this.#pending.delete(id);
        pending.resolve(msg.result);
        break;
      case "error":
        this.#pending.delete(id);
        pending.reject(
          new SidecarError(
            String(msg.error ?? "unknown engine error"),
            (msg.data as Record<string, unknown>) ?? {},
          ),
        );
        break;
    }
  }

  async call<T>(
    cmd: string,
    args: Record<string, unknown> = {},
    onEvent?: (e: SidecarEvent) => void,
  ): Promise<T> {
    await this.#ensure();
    const id = this.#nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent });
    });
    try {
      await this.#writer!.write(this.#enc.encode(JSON.stringify({ id, cmd, args }) + "\n"));
    } catch (err) {
      this.#pending.delete(id);
      throw new SidecarError(`engine write failed: ${err}`);
    }
    return await promise;
  }

  ping(): Promise<{
    python: string;
    pillow: boolean;
    lxml: boolean;
    vendor: boolean;
    vendorError?: string;
    deviceProfiles?: Record<string, { width: number; height: number }>;
  }> {
    return this.call("ping");
  }

  async stop() {
    const proc = this.#proc;
    this.#proc = null;
    if (!proc) return;
    try {
      await this.#writer?.close();
    } catch { /* already closed */ }
    this.#writer = null;
    try {
      proc.kill("SIGTERM");
    } catch { /* already exited */ }
    await proc.status.catch(() => {});
  }
}

function canExec(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
