// Books sent to one reader by hand.
//
// Sending one book is the primitive interaction; a folder rule
// (`LibraryConfig.deviceIds`) is the automation of it. Both put a book in a
// device's desired set and differ only in provenance, which is why this is a
// set of ids unioned into that set rather than a second delivery path — a sent
// book is resampled, stamped and hash-mapped by exactly the same loop.
//
// Kept out of `SyncEngine`, which is already long enough, and because the web
// server needs the same queries to answer "what is on this reader".
import type { Db } from "../core/db.ts";

export class Pins {
  constructor(private readonly db: Db) {}

  /** Book ids sent by hand to this reader, oldest first. */
  idsFor(deviceId: string): string[] {
    return this.db.all<{ book_id: string }>(
      "SELECT book_id FROM device_pin WHERE device_id = ? ORDER BY created_at",
      deviceId,
    ).map((r) => r.book_id);
  }

  /** Which readers this book was sent to — what the drawer lists. */
  devicesFor(bookId: string): string[] {
    return this.db.all<{ device_id: string }>(
      "SELECT device_id FROM device_pin WHERE book_id = ?",
      bookId,
    ).map((r) => r.device_id);
  }

  /** Every send, for the whole-table scan `/api/library` does per request. */
  all(): { deviceId: string; bookId: string }[] {
    return this.db.all<{ device_id: string; book_id: string }>(
      "SELECT device_id, book_id FROM device_pin",
    ).map((r) => ({ deviceId: r.device_id, bookId: r.book_id }));
  }

  /** Idempotent: sending a book already sent is not an error, it is a no-op. */
  add(deviceId: string, bookIds: string[]) {
    const now = new Date().toISOString();
    this.db.tx(() => {
      for (const bookId of bookIds) {
        this.db.run(
          "INSERT OR IGNORE INTO device_pin (device_id, book_id, created_at) VALUES (?, ?, ?)",
          deviceId,
          bookId,
          now,
        );
      }
    });
  }

  /**
   * Un-send. The book leaves the desired set, and the next sync's ordinary
   * removal sweep takes it off the reader — unless a folder rule still covers
   * it, in which case nothing happens, which is correct.
   */
  remove(deviceId: string, bookIds: string[]) {
    this.db.tx(() => {
      for (const bookId of bookIds) {
        this.db.run(
          "DELETE FROM device_pin WHERE device_id = ? AND book_id = ?",
          deviceId,
          bookId,
        );
      }
    });
  }
}
