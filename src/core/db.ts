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
