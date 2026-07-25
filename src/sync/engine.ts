import { bit, type Db } from "../core/db.ts";
import type { ConfigStore } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import { bookIdFromDeviceFilename, deviceFilename } from "../core/ids.ts";
import type { Logger } from "../core/log.ts";
import type { DeviceClient } from "../device/client.ts";
import { joinDevicePath, normalizeDevicePath } from "../device/client.ts";
import type { DeviceManager } from "../device/manager.ts";
import type { Sidecar } from "../engine/sidecar.ts";
import { SidecarError } from "../engine/sidecar.ts";
import type { Books } from "../library/books.ts";
import { fmtBytes } from "../library/ingest.ts";
import { Profiles, type ResampleProfile } from "./profiles.ts";

export interface SyncRule {
  device_id: string;
  source_type: "library" | "list";
  source_list_id: string | null;
  mode: "add_new" | "mirror";
  profile_id: string | null;
  enabled: number;
  auto_on_connect: number;
}

export interface SyncResult {
  deviceId: string;
  started: string;
  durationMs: number;
  sent: number;
  failed: number;
  deleted: number;
  upToDate: number;
  skipped?: string;
  message: string;
}

export class SyncEngine {
  #running = new Set<string>();
  #rerun = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly config: ConfigStore,
    private readonly books: Books,
    private readonly profiles: Profiles,
    private readonly devices: DeviceManager,
    private readonly sidecar: Sidecar,
    private readonly log: Logger,
    private readonly bus: EventBus,
  ) {}

  rule(deviceId: string): SyncRule {
    let row = this.db.get<SyncRule>("SELECT * FROM sync_rule WHERE device_id = ?", deviceId);
    if (!row) {
      this.db.run("INSERT INTO sync_rule (device_id) VALUES (?)", deviceId);
      row = this.db.get<SyncRule>("SELECT * FROM sync_rule WHERE device_id = ?", deviceId)!;
    }
    return row;
  }

  setRule(deviceId: string, patch: Partial<SyncRule>): SyncRule {
    const cur = this.rule(deviceId);
    const next: SyncRule = {
      ...cur,
      ...patch,
      source_type: (patch.source_type ?? cur.source_type) === "list" ? "list" : "library",
      mode: (patch.mode ?? cur.mode) === "mirror" ? "mirror" : "add_new",
    };
    this.db.run(
      `UPDATE sync_rule SET source_type = ?, source_list_id = ?, mode = ?, profile_id = ?,
                            enabled = ?, auto_on_connect = ?
       WHERE device_id = ?`,
      next.source_type,
      next.source_type === "list" ? next.source_list_id : null,
      next.mode,
      next.profile_id,
      bit(next.enabled),
      bit(next.auto_on_connect),
      deviceId,
    );
    return this.rule(deviceId);
  }

  /** Contents of a device per our manifest, joined with book titles. */
  contents(deviceId: string) {
    return this.db.all(
      `SELECT dc.*, b.title, b.author FROM device_content dc
       LEFT JOIN book b ON b.id = dc.book_id
       WHERE dc.device_id = ? ORDER BY b.title COLLATE NOCASE`,
      deviceId,
    );
  }

  /** Auto-sync entry point (device connected). Respects the pause switch. */
  onDeviceConnected(deviceId: string) {
    if (!this.config.current.autoSyncEnabled) {
      this.log.info(
        "sync.paused",
        `Auto-sync is paused; skipping ${this.devices.label(deviceId)}`,
        {
          deviceId,
        },
      );
      return;
    }
    const rule = this.rule(deviceId);
    if (!rule.enabled || !rule.auto_on_connect) {
      this.log.debug(
        "sync.auto.disabled",
        `Auto-sync disabled for ${this.devices.label(deviceId)}`,
        {
          deviceId,
        },
      );
      return;
    }
    this.sync(deviceId, "auto").catch((err) =>
      this.log.error("sync.failed", `Auto-sync failed: ${err}`, { deviceId })
    );
  }

  /**
   * Sync one device. Never runs twice concurrently for the same device; a
   * trigger arriving mid-run queues exactly one follow-up pass.
   */
  async sync(deviceId: string, trigger: "auto" | "manual"): Promise<SyncResult> {
    if (this.#running.has(deviceId)) {
      this.#rerun.add(deviceId);
      this.log.debug("sync.queued", `Sync already running for ${this.devices.label(deviceId)}`, {
        deviceId,
      });
      return this.#empty(deviceId, "already running");
    }
    this.#running.add(deviceId);
    this.devices.markSyncing(deviceId, true);
    try {
      const result = await this.#run(deviceId, trigger);
      this.devices.markSyncing(deviceId, false, result.message);
      return result;
    } finally {
      this.#running.delete(deviceId);
      if (this.#rerun.delete(deviceId)) {
        this.sync(deviceId, trigger).catch(() => {});
      }
    }
  }

  #empty(deviceId: string, skipped: string): SyncResult {
    return {
      deviceId,
      started: new Date().toISOString(),
      durationMs: 0,
      sent: 0,
      failed: 0,
      deleted: 0,
      upToDate: 0,
      skipped,
      message: `Skipped: ${skipped}`,
    };
  }

  async #run(deviceId: string, trigger: string): Promise<SyncResult> {
    const t0 = performance.now();
    const started = new Date().toISOString();
    const rule = this.rule(deviceId);
    const label = this.devices.label(deviceId);

    if (!rule.enabled && trigger !== "manual") return this.#empty(deviceId, "rule disabled");

    const client = this.devices.clientFor(deviceId);
    if (!client) return this.#empty(deviceId, "device address unknown");

    const cfg = this.config.current;
    const profile = rule.profile_id ? this.profiles.get(rule.profile_id) ?? null : null;
    this.log.info(
      "sync.start",
      `Sync (${trigger}) started for ${label}: ${rule.source_type}` +
        `${rule.source_type === "list" ? ` “${this.#listName(rule.source_list_id)}”` : ""}, ` +
        `${rule.mode}, profile ${profile ? profile.name : "none"}`,
      { deviceId, detail: { rule } },
    );

    // 1. what's on the device now
    let onDevice: { path: string; name: string; size: number }[];
    try {
      onDevice = await client.listEpubs("/");
    } catch (err) {
      const msg = `Could not list device contents: ${err}`;
      this.log.error("sync.failed", msg, { deviceId });
      return { ...this.#empty(deviceId, "unreachable"), message: msg };
    }

    // 2. reconcile the manifest with reality (files may have been deleted on-device)
    const manifest = this.db.all<{ book_id: string; device_path: string }>(
      "SELECT book_id, device_path FROM device_content WHERE device_id = ?",
      deviceId,
    );
    const presentPaths = new Set(onDevice.map((f) => normalizeDevicePath(f.path)));
    for (const row of manifest) {
      if (!presentPaths.has(normalizeDevicePath(row.device_path))) {
        this.db.run(
          "DELETE FROM device_content WHERE device_id = ? AND book_id = ?",
          deviceId,
          row.book_id,
        );
      }
    }

    // Book ids present on device: manifest first, then filename matching (§9).
    const presentBooks = new Map<string, string>(); // bookId -> device path
    for (
      const row of this.db.all<{ book_id: string; device_path: string }>(
        "SELECT book_id, device_path FROM device_content WHERE device_id = ?",
        deviceId,
      )
    ) {
      presentBooks.set(row.book_id, row.device_path);
    }
    const unmanaged: string[] = [];
    for (const file of onDevice) {
      const bookId = bookIdFromDeviceFilename(file.name);
      if (bookId) {
        if (!presentBooks.has(bookId)) presentBooks.set(bookId, file.path);
      } else if (![...presentBooks.values()].includes(file.path)) {
        unmanaged.push(file.path);
      }
    }

    // 3. desired set
    const desired = this.books.idsForSource(rule.source_type, rule.source_list_id);
    const desiredSet = new Set(desired);
    const toSend = desired.filter((id) => !presentBooks.has(id));
    const upToDate = desired.length - toSend.length;

    // 4. mirror: remove books we placed that are no longer wanted
    let deleted = 0;
    if (rule.mode === "mirror") {
      const stale = [...presentBooks.entries()].filter(([id]) => !desiredSet.has(id));
      if (stale.length) {
        try {
          await client.delete(stale.map(([, path]) => path));
          for (const [id] of stale) {
            this.db.run(
              "DELETE FROM device_content WHERE device_id = ? AND book_id = ?",
              deviceId,
              id,
            );
          }
          deleted = stale.length;
          this.log.info("sync.deleted", `Removed ${deleted} stale book(s) from ${label}`, {
            deviceId,
            detail: { paths: stale.map(([, p]) => p) },
          });
        } catch (err) {
          this.log.warn("sync.delete.failed", `Could not delete stale books: ${err}`, { deviceId });
        }
      }
      if (unmanaged.length) {
        this.log.info(
          "sync.unmanaged",
          `Left ${unmanaged.length} file(s) not sent by Pocket Sync in place`,
          { deviceId, detail: { paths: unmanaged.slice(0, 20) } },
        );
      }
    }

    // 5. upload
    const targetDir = normalizeDevicePath(cfg.upload.path || "/");
    if (targetDir !== "/") {
      try {
        await client.ensureDir("/", targetDir.split("/").filter(Boolean));
      } catch (err) {
        this.log.warn("sync.mkdir.failed", `Could not create ${targetDir}: ${err}`, { deviceId });
      }
    }

    let sent = 0;
    let failed = 0;
    let connectionLost = false;

    for (const [index, bookId] of toSend.entries()) {
      const book = this.books.get(bookId);
      if (!book) continue;
      if (!book.epub_path) {
        failed++;
        this.log.error("sync.book.failed", `“${book.title}” has no EPUB to send`, {
          deviceId,
          bookId,
        });
        continue;
      }
      this.bus.emit({
        level: "debug",
        event: "sync.book.start",
        message: `Sending “${book.title}” (${index + 1}/${toSend.length})`,
        deviceId,
        bookId,
        detail: { index: index + 1, total: toSend.length },
      });

      let sendPath: string;
      try {
        sendPath = (await this.profiles.fileForSend(book, profile)).path;
      } catch (err) {
        failed++;
        this.log.error("sync.optimize.failed", `Optimize failed for “${book.title}”: ${err}`, {
          deviceId,
          bookId,
        });
        continue;
      }

      const filename = deviceFilename(book.id, book.title);
      const devicePath = joinDevicePath(targetDir, filename);
      const ok = await this.#uploadWithRetry(client, deviceId, book.id, book.title, {
        host: client.hostname,
        port: client.wsPort,
        uploadPath: targetDir,
        filename,
        filePath: sendPath,
        devicePath,
      });

      if (ok === "sent") {
        sent++;
        const size = (await Deno.stat(sendPath)).size;
        this.db.run(
          `INSERT INTO device_content (device_id, book_id, device_filename, device_path,
                                       size_bytes, profile_hash, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id, book_id) DO UPDATE SET
             device_filename = excluded.device_filename, device_path = excluded.device_path,
             size_bytes = excluded.size_bytes, profile_hash = excluded.profile_hash,
             synced_at = excluded.synced_at`,
          deviceId,
          book.id,
          filename,
          devicePath,
          size,
          profile ? profile.id : null,
          new Date().toISOString(),
        );
        this.#logSync(deviceId, book.id, "info", "sync.book.done", `Sent “${book.title}”`);
        if (cfg.upload.bookCooldownSec > 0 && index < toSend.length - 1) {
          await sleep(cfg.upload.bookCooldownSec * 1000);
        }
      } else {
        failed++;
        if (ok === "offline") {
          connectionLost = true;
          this.log.warn(
            "sync.interrupted",
            `Device ${label} stopped responding — ${toSend.length - index - 1} book(s) deferred ` +
              `to the next connection`,
            { deviceId },
          );
          break;
        }
      }
    }

    const durationMs = performance.now() - t0;
    const message = connectionLost
      ? `Interrupted: ${sent} sent, ${failed} failed, ${deleted} removed`
      : `${sent} sent, ${failed} failed, ${deleted} removed, ${upToDate} already there`;
    this.log.info(
      "sync.done",
      `Sync finished for ${label}: ${message} in ${(durationMs / 1000).toFixed(1)}s`,
      { deviceId, detail: { sent, failed, deleted, upToDate, trigger } },
    );
    return { deviceId, started, durationMs, sent, failed, deleted, upToDate, message };
  }

  /** Upload one book, retrying with backoff and cleaning up partial files. */
  async #uploadWithRetry(
    client: DeviceClient,
    deviceId: string,
    bookId: string,
    title: string,
    args: {
      host: string;
      port: number;
      uploadPath: string;
      filename: string;
      filePath: string;
      devicePath: string;
    },
  ): Promise<"sent" | "failed" | "offline"> {
    const cfg = this.config.current.upload;
    const attempts = Math.max(1, cfg.retries + 1);
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.sidecar.call("upload", {
          host: args.host,
          port: args.port,
          uploadPath: args.uploadPath,
          filename: args.filename,
          filePath: args.filePath,
          chunkSize: cfg.chunkSize,
          timeout: cfg.socketTimeoutSec,
        }, (e) => {
          if (e.tag === "PROGRESS" && typeof e.sent === "number" && typeof e.total === "number") {
            this.bus.emit({
              level: "debug",
              event: "sync.progress",
              message: `${title}: ${fmtBytes(e.sent)} / ${fmtBytes(e.total)}`,
              deviceId,
              bookId,
              detail: { sent: e.sent, total: e.total, percent: e.total ? e.sent / e.total : 0 },
            });
          }
        });
        return "sent";
      } catch (err) {
        lastErr = err;
        const started = err instanceof SidecarError && err.uploadStarted;
        this.log.warn(
          "sync.upload.retry",
          `Upload of “${title}” failed (attempt ${attempt}/${attempts}): ${err}`,
          { deviceId, bookId },
        );
        if (started) {
          // Remove the partial file so a retry doesn't leave a corrupt book.
          await client.delete([args.devicePath]).catch((cleanupErr) =>
            this.log.debug("sync.cleanup", `Partial cleanup ignored: ${cleanupErr}`, { deviceId })
          );
        }
        if (attempt < attempts) await sleep(cfg.retryDelaySec * 1000 * attempt);
      }
    }

    // Last resort: the firmware's WebDAV endpoint (§8.2).
    if (cfg.webdavFallback) {
      try {
        this.log.info("sync.webdav", `Trying WebDAV upload for “${title}”`, { deviceId, bookId });
        await client.putFile(args.devicePath, await Deno.readFile(args.filePath));
        this.log.info("sync.webdav.ok", `WebDAV upload succeeded for “${title}”`, {
          deviceId,
          bookId,
        });
        return "sent";
      } catch (err) {
        await client.delete([args.devicePath]).catch(() => {});
        this.log.warn("sync.webdav.failed", `WebDAV upload failed for “${title}”: ${err}`, {
          deviceId,
          bookId,
        });
      }
    }

    this.#logSync(
      deviceId,
      bookId,
      "error",
      "sync.book.failed",
      `Failed to send “${title}”: ${lastErr}`,
    );
    this.log.error("sync.book.failed", `Failed to send “${title}”: ${lastErr}`, {
      deviceId,
      bookId,
    });
    return (await client.reachable()) ? "failed" : "offline";
  }

  #listName(listId: string | null): string {
    if (!listId) return "(none)";
    return this.db.get<{ name: string }>('SELECT name FROM "list" WHERE id = ?', listId)?.name ??
      "(deleted list)";
  }

  #logSync(deviceId: string, bookId: string | null, level: string, event: string, detail: string) {
    this.db.run(
      "INSERT INTO sync_log (device_id, book_id, ts, level, event, detail) VALUES (?, ?, ?, ?, ?, ?)",
      deviceId,
      bookId,
      new Date().toISOString(),
      level,
      event,
      detail,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type { ResampleProfile };
export { Profiles };
