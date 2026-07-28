import type { Db } from "../core/db.ts";
import type { Paths } from "../core/paths.ts";

export interface Book {
  id: string;
  title: string;
  author: string;
  series: string | null;
  series_index: number | null;
  added_at: string;
  cover_path: string | null;
  original_ext: string;
  epub_path: string | null;
  size_bytes: number;
  meta_json: string;
}

/** A book as the library view sees it: within one folder, with reading state. */
export interface LibraryRow extends Book {
  library_id: string;
  path: string;
  percentage: number;
  finished: number;
}

export type ReadingFilter = "all" | "reading" | "unread" | "finished";

export interface BookQuery {
  query?: string;
  libraryId?: string;
  /** Whose progress to show. Reading state is per person, so the shelf is
   * always somebody's shelf; without this there is no honest answer. */
  userId?: string;
  reading?: ReadingFilter;
  limit?: number;
  offset?: number;
}

export class Books {
  constructor(private readonly db: Db, private readonly paths: Paths) {}

  /**
   * Books visible in a folder, with one person's reading state attached.
   */
  list(q: BookQuery = {}): LibraryRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [q.userId ?? ""];

    if (q.libraryId) {
      where.push("lb.library_id = ?");
      params.push(q.libraryId);
    }
    if (q.query?.trim()) {
      where.push("(b.title LIKE ? OR b.author LIKE ? OR b.series LIKE ?)");
      const like = `%${q.query.trim()}%`;
      params.push(like, like, like);
    }
    switch (q.reading) {
      case "finished":
        where.push("COALESCE(rs.finished, 0) = 1");
        break;
      case "reading":
        where.push("COALESCE(rs.finished, 0) = 0 AND COALESCE(rs.percentage, 0) > 0");
        break;
      case "unread":
        where.push("COALESCE(rs.finished, 0) = 0 AND COALESCE(rs.percentage, 0) = 0");
        break;
    }

    const sql = `
      SELECT b.*, lb.library_id, lb.path,
             COALESCE(rs.percentage, 0) AS percentage,
             COALESCE(rs.finished, 0)   AS finished
      FROM library_book lb
      JOIN book b ON b.id = lb.book_id
      LEFT JOIN reading_state rs
             ON rs.book_id = lb.book_id AND rs.user_id = ?
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY b.title COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    params.push(q.limit ?? 5000, q.offset ?? 0);
    return this.db.all<LibraryRow>(sql, ...params);
  }

  get(id: string): Book | undefined {
    return this.db.get<Book>("SELECT * FROM book WHERE id = ?", id);
  }

  /**
   * The desired set for a device: every book across all the folders it syncs,
   * deduplicated — the same file in two folders is one book and goes once.
   */
  idsForLibraries(libraryIds: string[]): string[] {
    if (!libraryIds.length) return [];
    const holes = libraryIds.map(() => "?").join(",");
    return this.db.all<{ book_id: string }>(
      `SELECT DISTINCT lb.book_id FROM library_book lb
       JOIN book b ON b.id = lb.book_id
       WHERE lb.library_id IN (${holes})
       ORDER BY b.title COLLATE NOCASE`,
      ...libraryIds,
    ).map((r) => r.book_id);
  }

  librariesFor(bookId: string) {
    return this.db.all<{ library_id: string; path: string }>(
      "SELECT library_id, path FROM library_book WHERE book_id = ?",
      bookId,
    );
  }

  /** Record that a folder holds this book at this path. */
  addToLibrary(libraryId: string, bookId: string, path: string) {
    this.db.run(
      `INSERT INTO library_book (library_id, book_id, path, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (library_id, book_id) DO UPDATE SET path = excluded.path`,
      libraryId,
      bookId,
      path,
      new Date().toISOString(),
    );
  }

  /**
   * The file left the folder. The book row and its derived artifacts stay — the
   * artifacts are keyed by content and another library may share them, and the
   * reading state is worth keeping so re-adding the file restores it.
   */
  removeFromLibrary(libraryId: string, bookId: string) {
    this.db.run(
      "DELETE FROM library_book WHERE library_id = ? AND book_id = ?",
      libraryId,
      bookId,
    );
  }

  update(id: string, patch: Partial<Pick<Book, "title" | "author" | "series" | "series_index">>) {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      params.push(v as string | number | null);
    }
    if (!sets.length) return;
    params.push(id);
    this.db.run(`UPDATE book SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }

  /**
   * Drop a book entirely, including its derived artifacts. Only safe once no
   * folder holds it — `removeFromLibrary` is what a vanished file triggers.
   */
  purge(id: string) {
    this.db.run("DELETE FROM book WHERE id = ?", id);
    try {
      Deno.removeSync(this.paths.bookDir(id), { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  /** Which devices hold this book, per our manifest. */
  devicesWith(bookId: string) {
    return this.db.all<{ device_id: string; device_path: string; synced_at: string }>(
      `SELECT dc.device_id, dc.device_path, dc.synced_at
       FROM device_content dc WHERE dc.book_id = ?`,
      bookId,
    );
  }
}
