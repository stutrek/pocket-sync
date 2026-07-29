import { DatabaseSync } from "node:sqlite";
import { newId } from "./ids.ts";

export type Row = Record<string, unknown>;
export type Param = string | number | null | Uint8Array;

const MIGRATIONS: string[] = [
  // v1 — initial schema (§9)
  `
  CREATE TABLE book (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    author        TEXT NOT NULL DEFAULT '',
    series        TEXT,
    series_index  REAL,
    added_at      TEXT NOT NULL,
    cover_path    TEXT,
    original_path TEXT NOT NULL,
    original_ext  TEXT NOT NULL,
    epub_path     TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    meta_json     TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX book_title_idx ON book(title);
  CREATE INDEX book_author_idx ON book(author);

  CREATE TABLE format (
    book_id TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    ext     TEXT NOT NULL,
    path    TEXT NOT NULL,
    PRIMARY KEY (book_id, ext)
  );

  CREATE TABLE "list" (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE list_item (
    list_id  TEXT NOT NULL REFERENCES "list"(id) ON DELETE CASCADE,
    book_id  TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (list_id, book_id)
  );

  CREATE TABLE device (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'crosspoint',
    model       TEXT,
    name        TEXT,
    last_ip     TEXT,
    last_port   INTEGER NOT NULL DEFAULT 81,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    id_strategy TEXT NOT NULL DEFAULT 'ip',
    status_json TEXT NOT NULL DEFAULT '{}',
    notes       TEXT
  );

  CREATE TABLE device_content (
    device_id       TEXT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    book_id         TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    device_filename TEXT NOT NULL,
    device_path     TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    profile_hash    TEXT,
    synced_at       TEXT NOT NULL,
    PRIMARY KEY (device_id, book_id)
  );

  CREATE TABLE sync_rule (
    device_id      TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
    source_type    TEXT NOT NULL DEFAULT 'library',
    source_list_id TEXT REFERENCES "list"(id) ON DELETE SET NULL,
    mode           TEXT NOT NULL DEFAULT 'add_new',
    profile_id     TEXT REFERENCES resample_profile(id) ON DELETE SET NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    auto_on_connect INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE resample_profile (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    device_model TEXT NOT NULL DEFAULT 'X4',
    jpeg_quality INTEGER NOT NULL DEFAULT 85,
    grayscale    INTEGER NOT NULL DEFAULT 1,
    auto_crop    INTEGER NOT NULL DEFAULT 0,
    split_text   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE sync_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    book_id   TEXT,
    ts        TEXT NOT NULL,
    level     TEXT NOT NULL,
    event     TEXT NOT NULL,
    detail    TEXT
  );
  CREATE INDEX sync_log_ts_idx ON sync_log(ts);

  CREATE TABLE setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v2 — the filesystem becomes the source of truth (docs/DESIGN.md).
  //
  // Book identity changes from a generated id to the MD5 of the source file, so
  // old `book` rows cannot be converted — they describe app-owned copies under
  // library/<id>/ that this model no longer keeps. They are dropped and rebuilt
  // by the first folder scan. `device_content` is cleared with them; files left
  // on a device under the old `<bookId>__<title>.epub` scheme stay attributable
  // via `bookIdFromDeviceFilename()` and are cleaned up by the first sync.
  `
  DROP TABLE format;
  DROP TABLE list_item;
  DROP TABLE "list";
  DELETE FROM device_content;
  DROP TABLE book;

  CREATE TABLE book (
    id            TEXT PRIMARY KEY,          -- MD5 hex of the source file
    title         TEXT NOT NULL,
    author        TEXT NOT NULL DEFAULT '',
    series        TEXT,
    series_index  REAL,
    added_at      TEXT NOT NULL,
    cover_path    TEXT,
    original_ext  TEXT NOT NULL,
    epub_path     TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    meta_json     TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX book_title_idx ON book(title);
  CREATE INDEX book_author_idx ON book(author);

  -- Which folders hold this book, and where. A book present in two libraries is
  -- one row each and one shared set of derived artifacts.
  CREATE TABLE library_book (
    library_id TEXT NOT NULL,
    book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
    path       TEXT NOT NULL,
    added_at   TEXT NOT NULL,
    PRIMARY KEY (library_id, book_id)
  );
  CREATE INDEX library_book_book_idx ON library_book(book_id);

  -- Scan cache: hashing is keyed on (size, mtime) so a rescan only rehashes
  -- files that actually changed. This is what makes MD5 identity affordable.
  CREATE TABLE file_index (
    path       TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    size       INTEGER NOT NULL,
    mtime      INTEGER NOT NULL,
    md5        TEXT NOT NULL,
    seen_at    TEXT NOT NULL
  );
  CREATE INDEX file_index_library_idx ON file_index(library_id);

  -- Imports are durable so one that blocks on the user (a DRM key, a missing
  -- plugin) survives a window close instead of vanishing with a toast.
  CREATE TABLE import_job (
    id         TEXT PRIMARY KEY,
    library_id TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    filename   TEXT NOT NULL,
    book_id    TEXT,
    stage      TEXT NOT NULL DEFAULT 'queued',
    state      TEXT NOT NULL DEFAULT 'running',  -- running|blocked|done|failed
    needs      TEXT,                             -- drm-key|drm-plugin|drm-plugin-disabled|drm-kfx|calibre|calibre-busy
    error      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX import_job_state_idx ON import_job(state);

  -- Reading progress, fed by the kosync listener. Keyed per library so two
  -- people reading the same file are independent, and kept when the source file
  -- disappears so re-adding it restores where you were.
  CREATE TABLE reading_state (
    library_id      TEXT NOT NULL,
    book_id         TEXT NOT NULL,
    percentage      REAL NOT NULL DEFAULT 0,
    position_json   TEXT NOT NULL DEFAULT '{}',
    finished        INTEGER NOT NULL DEFAULT 0,
    finished_source TEXT,                        -- auto|manual
    device_id       TEXT,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (library_id, book_id)
  );

  -- Maps the hash the reader reports (computed over the delivered bytes, which
  -- differ per resample profile) back to our source-file MD5.
  CREATE TABLE kosync_document (
    document_hash TEXT PRIMARY KEY,
    book_id       TEXT NOT NULL,
    profile_hash  TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE kosync_user (
    username   TEXT PRIMARY KEY,
    key_md5    TEXT NOT NULL,
    library_id TEXT,
    created_at TEXT NOT NULL
  );

  -- What survives of sync_rule. The bound folder is the source, so there is no
  -- source type, no list and no mode left to choose.
  CREATE TABLE device_settings (
    device_id       TEXT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
    profile_id      TEXT REFERENCES resample_profile(id) ON DELETE SET NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    auto_on_connect INTEGER NOT NULL DEFAULT 1
  );
  INSERT INTO device_settings (device_id, profile_id, enabled, auto_on_connect)
    SELECT device_id, profile_id, enabled, auto_on_connect FROM sync_rule;
  DROP TABLE sync_rule;
  `,

  // v3 — users, and many folders per device (docs/DESIGN.md).
  //
  // Reverses "one device syncs one folder". A user is a named config entry, not
  // an account; a device records which user is currently holding it, and reading
  // progress keys on that user rather than on a folder — so one person reading
  // from two folders has a single position per book.
  `
  ALTER TABLE device_settings ADD COLUMN user_id TEXT;

  CREATE TABLE reading_state_v3 (
    user_id         TEXT NOT NULL,
    book_id         TEXT NOT NULL,
    percentage      REAL NOT NULL DEFAULT 0,
    position_json   TEXT NOT NULL DEFAULT '{}',
    finished        INTEGER NOT NULL DEFAULT 0,
    finished_source TEXT,
    device_id       TEXT,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (user_id, book_id)
  );
  DROP TABLE reading_state;
  ALTER TABLE reading_state_v3 RENAME TO reading_state;

  -- kosync credentials likewise belong to a person, not a folder.
  DROP TABLE kosync_user;
  CREATE TABLE kosync_user (
    username   TEXT PRIMARY KEY,
    key_md5    TEXT NOT NULL,
    user_id    TEXT,
    created_at TEXT NOT NULL
  );
  `,

  // v4 — we configure the reader's own KOReader Sync client rather than asking
  // the user to type a URL and a password on an e-ink keyboard.
  //
  // `kosync_hash` fingerprints what the reader last accepted, so the usual sync
  // costs no extra round trip; the rest is what the Devices view reports when
  // it did not take.
  `
  ALTER TABLE device_settings ADD COLUMN kosync_hash   TEXT;
  ALTER TABLE device_settings ADD COLUMN kosync_state  TEXT;
  ALTER TABLE device_settings ADD COLUMN kosync_detail TEXT;
  ALTER TABLE device_settings ADD COLUMN kosync_at     TEXT;
  `,

  // v5 — a person has several sync servers, and a reader may be pinned to one
  // of them rather than following its holder's default.
  //
  // NULL is the normal value and means "whoever is holding this reader decides",
  // which is what makes handing a reader over re-point it.
  `
  ALTER TABLE device_settings ADD COLUMN sync_server_id TEXT;

  -- 'conflict' was a dead end: a reader found pointing at somebody else's sync
  -- server was left alone forever with no way to record what it pointed at.
  -- That server is now adopted into the holder's list instead, so clear the
  -- verdict and let the next sync reach it.
  UPDATE device_settings
     SET kosync_state = NULL, kosync_detail = NULL, kosync_at = NULL
   WHERE kosync_state = 'conflict';
  `,

  // v6 — the reader's own OPDS catalog list, which it can browse and pull from.
  //
  // Tracked separately from the page-sync columns rather than folded into them:
  // the two are pushed to different endpoints, either can succeed while the
  // other fails, and a reader nobody is holding can still have a working
  // catalog even though it must never be given page-sync credentials.
  `
  ALTER TABLE device_settings ADD COLUMN opds_hash   TEXT;
  ALTER TABLE device_settings ADD COLUMN opds_state  TEXT;
  ALTER TABLE device_settings ADD COLUMN opds_detail TEXT;
  ALTER TABLE device_settings ADD COLUMN opds_at     TEXT;
  `,

  // v7 — positions for files we did not deliver.
  //
  // A reader holds side-loaded books too, and their document hash matches no
  // row in `kosync_document` — nor can it ever, since we have never seen those
  // bytes. Dropping the report made page sync look broken on exactly the book
  // someone was testing with: the reader is answered, reads back nothing, and
  // opens at page one. Keyed by the document hash rather than a book, because a
  // book is the one thing we do not have.
  //
  // Not folded into `reading_state`: that table is joined into the library and
  // swept by `reconcile()` against known books, and a row with an invented
  // book_id would surface as a phantom or be deleted as an orphan.
  `
  CREATE TABLE unmapped_progress (
    user_id       TEXT NOT NULL,
    document_hash TEXT NOT NULL,
    percentage    REAL NOT NULL DEFAULT 0,
    payload_json  TEXT NOT NULL DEFAULT '{}',
    device_id     TEXT,
    updated_at    TEXT NOT NULL,
    PRIMARY KEY (user_id, document_hash)
  );
  `,
];

export class Db {
  readonly handle: DatabaseSync;

  constructor(path: string) {
    this.handle = new DatabaseSync(path);
    this.handle.exec("PRAGMA journal_mode = WAL");
    this.handle.exec("PRAGMA foreign_keys = ON");
    this.handle.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
    this.#seed();
  }

  #migrate() {
    const [{ user_version: version }] = this.all<{ user_version: number }>("PRAGMA user_version");
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.handle.exec("BEGIN");
      try {
        this.handle.exec(MIGRATIONS[v]);
        this.handle.exec(`PRAGMA user_version = ${v + 1}`);
        this.handle.exec("COMMIT");
      } catch (err) {
        this.handle.exec("ROLLBACK");
        throw err;
      }
    }
  }

  #seed() {
    const n = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM resample_profile")!.n;
    if (n > 0) return;
    for (const [name, model] of [["X4 default", "X4"], ["X3 default", "X3"]] as const) {
      this.run(
        `INSERT INTO resample_profile (id, name, device_model, jpeg_quality, grayscale, auto_crop, split_text)
         VALUES (?, ?, ?, 85, 1, 0, 1)`,
        newId(),
        name,
        model,
      );
    }
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.handle.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.handle.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]) {
    return this.handle.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    this.handle.exec("BEGIN");
    try {
      const out = fn();
      this.handle.exec("COMMIT");
      return out;
    } catch (err) {
      this.handle.exec("ROLLBACK");
      throw err;
    }
  }

  close() {
    this.handle.close();
  }
}

/** SQLite has no boolean type; bind 0/1. */
export const bit = (b: unknown): number => (b ? 1 : 0);
