import type { Db } from "../core/db.ts";
import { newId } from "../core/ids.ts";

export type JobState = "running" | "blocked" | "done" | "failed";
/** What a blocked job is waiting for the user to supply. */
export type JobNeeds =
  | "drm-key"
  | "drm-plugin"
  | "drm-plugin-disabled"
  | "drm-kfx"
  | "calibre"
  | "calibre-busy";

export interface ImportJob {
  id: string;
  library_id: string;
  path: string;
  filename: string;
  book_id: string | null;
  stage: string;
  state: JobState;
  needs: JobNeeds | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The Inbox. Imports are durable rather than transient UI state, because with a
 * watched folder a batch can arrive while nobody is watching, and an import that
 * needs a DRM key has to wait rather than fail (docs/DESIGN.md).
 */
export class Imports {
  constructor(private readonly db: Db) {}

  /** Begin (or restart) the job for a path. One job per path. */
  start(libraryId: string, path: string, filename: string): ImportJob {
    const now = new Date().toISOString();
    const existing = this.byPath(path);
    if (existing) {
      this.db.run(
        `UPDATE import_job SET state = 'running', stage = 'queued', needs = NULL, error = NULL,
                               library_id = ?, filename = ?, updated_at = ?
         WHERE id = ?`,
        libraryId,
        filename,
        now,
        existing.id,
      );
      return this.get(existing.id)!;
    }
    const id = newId();
    this.db.run(
      `INSERT INTO import_job (id, library_id, path, filename, stage, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 'running', ?, ?)`,
      id,
      libraryId,
      path,
      filename,
      now,
      now,
    );
    return this.get(id)!;
  }

  stage(id: string, stage: string) {
    this.#touch(id, "stage = ?", stage);
  }

  done(id: string, bookId: string) {
    this.db.run(
      "UPDATE import_job SET state = 'done', stage = 'ready', book_id = ?, error = NULL, needs = NULL, updated_at = ? WHERE id = ?",
      bookId,
      new Date().toISOString(),
      id,
    );
  }

  fail(id: string, error: string) {
    this.db.run(
      "UPDATE import_job SET state = 'failed', error = ?, updated_at = ? WHERE id = ?",
      error,
      new Date().toISOString(),
      id,
    );
  }

  /** Waiting on the user. Stays in the Inbox until resolved. */
  block(id: string, needs: JobNeeds, error: string) {
    this.db.run(
      "UPDATE import_job SET state = 'blocked', needs = ?, error = ?, updated_at = ? WHERE id = ?",
      needs,
      error,
      new Date().toISOString(),
      id,
    );
  }

  get(id: string): ImportJob | undefined {
    return this.db.get<ImportJob>("SELECT * FROM import_job WHERE id = ?", id);
  }

  byPath(path: string): ImportJob | undefined {
    return this.db.get<ImportJob>("SELECT * FROM import_job WHERE path = ?", path);
  }

  /** Everything unfinished, plus recently completed rows so the UI can show ✓. */
  all(recentMinutes = 10): ImportJob[] {
    const since = new Date(Date.now() - recentMinutes * 60_000).toISOString();
    return this.db.all<ImportJob>(
      `SELECT * FROM import_job
       WHERE state IN ('running', 'blocked', 'failed') OR updated_at > ?
       ORDER BY created_at`,
      since,
    );
  }

  blocked(): ImportJob[] {
    return this.db.all<ImportJob>("SELECT * FROM import_job WHERE state = 'blocked'");
  }

  remove(id: string) {
    this.db.run("DELETE FROM import_job WHERE id = ?", id);
  }

  /** Drop the job for a path that has left the folder. */
  removeByPath(path: string) {
    this.db.run("DELETE FROM import_job WHERE path = ?", path);
  }

  /** Completed rows age out; blocked and failed ones never do. */
  prune(olderThanMinutes = 60) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    this.db.run("DELETE FROM import_job WHERE state = 'done' AND updated_at < ?", cutoff);
  }

  #touch(id: string, setClause: string, value: string) {
    this.db.run(
      `UPDATE import_job SET ${setClause}, updated_at = ? WHERE id = ?`,
      value,
      new Date().toISOString(),
      id,
    );
  }
}
