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
  /**
   * Only books whose source file sits under this absolute path prefix — how the
   * catalog browses into a subfolder.
   *
   * Compared with `instr(path, prefix) = 1` rather than `LIKE prefix || '%'`:
   * `_` is a single-character wildcard in LIKE and is extremely common in
   * filenames, so the pattern form would quietly match neighbouring folders.
   */
  pathPrefix?: string;
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
   *
   * Grouped by book: the same file held by two watched folders is one book and
   * must be listed once (invariant 7), and without the grouping an unfiltered
   * query — the whole library, or an OPDS catalog browsing it — would show it
   * twice. `library_id`/`path` are then one of the folders holding it, which is
   * exactly the filtered folder whenever the query named one.
   */
  list(q: BookQuery = {}): LibraryRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [q.userId ?? ""];

    if (q.libraryId) {
      where.push("lb.library_id = ?");
      params.push(q.libraryId);
    }
    if (q.pathPrefix) {
      where.push("instr(lb.path, ?) = 1");
      params.push(q.pathPrefix);
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
      GROUP BY b.id
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

  /**
   * Where each book in these folders actually sits on disk — what the device
   * layout mirrors (`devicePlacements()`).
   *
   * A book can be in several of a device's folders at once; the answer has to
   * be the same on every sync or the file would move around the reader, so the
   * rows are ordered and the first one wins rather than whichever the query
   * happened to return.
   */
  sourcePathsForLibraries(libraryIds: string[]): Map<string, { libraryId: string; path: string }> {
    const out = new Map<string, { libraryId: string; path: string }>();
    if (!libraryIds.length) return out;
    const holes = libraryIds.map(() => "?").join(",");
    for (
      const row of this.db.all<{ book_id: string; library_id: string; path: string }>(
        `SELECT book_id, library_id, path FROM library_book
         WHERE library_id IN (${holes})
         ORDER BY library_id, path`,
        ...libraryIds,
      )
    ) {
      if (!out.has(row.book_id)) {
        out.set(row.book_id, { libraryId: row.library_id, path: row.path });
      }
    }
    return out;
  }

  /**
   * Every source path in one folder. The catalog builds its folder tree from
   * these — the same evidence the device layout uses, so what a reader browses
   * and what a sync would place agree.
   */
  pathsIn(libraryId: string): string[] {
    return this.db.all<{ path: string }>(
      "SELECT path FROM library_book WHERE library_id = ?",
      libraryId,
    ).map((r) => r.path);
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
