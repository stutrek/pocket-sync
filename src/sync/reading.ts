import type { Db } from "../core/db.ts";
import type { EventBus } from "../core/events.ts";
import type { Logger } from "../core/log.ts";

/** A book this far through counts as finished unless the user says otherwise. */
export const FINISHED_AT = 0.99;

export interface ReadingState {
  user_id: string;
  book_id: string;
  percentage: number;
  position_json: string;
  finished: number;
  finished_source: "auto" | "manual" | null;
  device_id: string | null;
  updated_at: string;
}

/** The payload CrossPoint/KOReader sends, plus CrossPoint's richer position. */
export interface ProgressPayload {
  document: string;
  progress?: string;
  percentage?: number;
  device?: string;
  device_id?: string;
  timestamp?: number;
  position?: Record<string, unknown>;
}

/**
 * Reading progress reported by the reader, and the `finished` tag derived from
 * it.
 *
 * Keyed by **user**, not by folder: one person reading a book that appears in two
 * of their folders has a single position, while two people with a copy of the
 * same file stay independent. Kept when the source file disappears, so re-adding
 * it restores where you were (docs/DESIGN.md).
 */
export class Reading {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly bus: EventBus,
  ) {}

  get(userId: string, bookId: string): ReadingState | undefined {
    return this.db.get<ReadingState>(
      "SELECT * FROM reading_state WHERE user_id = ? AND book_id = ?",
      userId,
      bookId,
    );
  }

  /** Map a reported document hash back to our source-file MD5. */
  bookForDocument(documentHash: string): string | null {
    return this.db.get<{ book_id: string }>(
      "SELECT book_id FROM kosync_document WHERE document_hash = ?",
      documentHash,
    )?.book_id ?? null;
  }

  /**
   * Apply a progress report to exactly one folder.
   *
   * `userId` comes from the credentials the reader authenticated with, not from
   * the device name it reported. Two people holding a copy of the same book
   * produce the same document hash, so guessing the owner from a device name
   * would silently overwrite someone else's position. `deviceId` is recorded for
   * display only and may be null.
   */
  record(
    payload: ProgressPayload,
    userId: string,
    deviceId: string | null,
  ): { bookId: string | null } {
    const bookId = this.bookForDocument(payload.document);
    if (!bookId) {
      this.log.debug(
        "kosync.unknown",
        `Progress for unknown document ${payload.document}`,
        { detail: { deviceId, userId } },
      );
      return { bookId: null };
    }

    const pct = clampPercentage(payload);
    const existing = this.get(userId, bookId);
    // A manual finished flag is the user's word and outranks the reader.
    const finished = existing?.finished_source === "manual"
      ? existing.finished
      : pct >= FINISHED_AT
      ? 1
      : 0;
    const source = existing?.finished_source === "manual" ? "manual" : finished ? "auto" : null;

    this.db.run(
      `INSERT INTO reading_state (user_id, book_id, percentage, position_json, finished,
                                  finished_source, device_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         percentage = excluded.percentage, position_json = excluded.position_json,
         finished = excluded.finished, finished_source = excluded.finished_source,
         device_id = excluded.device_id, updated_at = excluded.updated_at`,
      userId,
      bookId,
      pct,
      JSON.stringify(payload.position ?? {}),
      finished,
      source,
      deviceId,
      new Date().toISOString(),
    );

    this.bus.emit({
      level: "info",
      event: "reading.progress",
      message: `Progress ${Math.round(pct * 100)}% from ${payload.device ?? "reader"}`,
      bookId,
      detail: { percentage: pct, deviceId, userId },
    });
    return { bookId };
  }

  /** Drop a departed user's positions. */
  forgetUser(userId: string) {
    this.db.run("DELETE FROM reading_state WHERE user_id = ?", userId);
  }

  /** Manual override — the reader only reports when the user taps sync. */
  setFinished(userId: string, bookId: string, finished: boolean) {
    this.db.run(
      `INSERT INTO reading_state (user_id, book_id, percentage, finished, finished_source,
                                  updated_at)
       VALUES (?, ?, ?, ?, 'manual', ?)
       ON CONFLICT (user_id, book_id) DO UPDATE SET
         finished = excluded.finished, finished_source = 'manual',
         updated_at = excluded.updated_at`,
      userId,
      bookId,
      finished ? 1 : 0,
      finished ? 1 : 0,
      new Date().toISOString(),
    );
  }
}

/** `percentage` is 0–1; CrossPoint's `pctQ` is the same number × 1e6. */
function clampPercentage(payload: ProgressPayload): number {
  const pctQ = payload.position?.pctQ;
  const raw = typeof pctQ === "number" ? pctQ / 1_000_000 : payload.percentage ?? 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}
