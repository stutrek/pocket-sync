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

/**
 * A book as the library view sees it: within one folder, with reading state.
 *
 * `library_id`/`path` are null for a book that is on a reader but in no watched
 * folder any more — the file was moved or deleted after we sent it. That is a
 * real state, not a defect: the reader still holds the book, a sync deliberately
 * leaves it alone, and the shelf gives it its own group rather than pretending
 * it is filed somewhere.
 */
export interface LibraryRow extends Book {
  library_id: string | null;
  path: string | null;
  percentage: number;
  finished: number;
}

export type ReadingFilter = "all" | "reading" | "unread" | "finished";

export interface BookQuery {
  query?: string;
  libraryId?: string;
  /**
   * Narrow to these folders — how a scope says "this reader's shelf". Left
   * undefined means every folder; an empty array means none, which is not the
   * same thing and must not be normalised away.
   */
  libraryIds?: string[];
  /**
   * Books to include whatever the folder filter says: what a reader is
   * carrying, and what a person is part-way through. These are the rows that
   * make a scope show its own contents rather than the whole library with
   * different annotations.
   */
  includeBookIds?: string[];
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
   * Books in scope, with one person's reading state attached.
   *
   * Grouped by book: the same file held by two watched folders is one book and
   * must be listed once (invariant 7), and without the grouping an unfiltered
   * query — the whole library, or an OPDS catalog browsing it — would show it
   * twice. `library_id`/`path` are then one of the folders holding it, which is
   * exactly the filtered folder whenever the query named one.
   *
   * Driven from `book` with a *left* join to `library_book`, not the other way
   * round: a book on a reader whose file has since left every watched folder has
   * no `library_book` row at all, and the folder-first shape could not express
   * it. The join carries the folder filter with it so the surviving row is one
   * of the folders actually asked for, rather than any folder holding the book.
   *
   * Params are pushed in the order the placeholders appear. That discipline is
   * what makes this query safe to keep extending — the reading-state user comes
   * first because its join is first, and limit/offset stay last.
   */
  list(q: BookQuery = {}): LibraryRow[] {
    const where: string[] = [];
    const joinOn: string[] = ["lb.book_id = b.id"];
    const params: (string | number)[] = [];

    if (q.libraryId) {
      joinOn.push("lb.library_id = ?");
      params.push(q.libraryId);
    }
    if (q.libraryIds) {
      const holes = q.libraryIds.length ? q.libraryIds.map(() => "?").join(",") : "''";
      joinOn.push(`lb.library_id IN (${holes})`);
      params.push(...q.libraryIds);
    }
    if (q.pathPrefix) {
      joinOn.push("instr(lb.path, ?) = 1");
      params.push(q.pathPrefix);
    }

    // The reading-state join comes after the folder join, so its parameter does.
    params.push(q.userId ?? "");

    // A book qualifies by sitting in one of the folders asked for, or by being
    // named outright — carried by this reader, or part-way through by this
    // person.
    const reach = ["lb.library_id IS NOT NULL"];
    if (q.includeBookIds?.length) {
      reach.push(`b.id IN (${q.includeBookIds.map(() => "?").join(",")})`);
    }
    where.push(`(${reach.join(" OR ")})`);
    if (q.includeBookIds?.length) params.push(...q.includeBookIds);

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
      FROM book b
      LEFT JOIN library_book lb ON ${joinOn.join(" AND ")}
      LEFT JOIN reading_state rs
             ON rs.book_id = b.id AND rs.user_id = ?
      WHERE ${where.join(" AND ")}
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
   * The desired set for a device: every book a folder rule covers, plus every
   * book sent to it by hand, deduplicated and in one order.
   *
   * One query rather than two unioned in JS, because the send loop reports
   * `index of total` against this order and a concatenation would put the sent
   * books in a second alphabet after the rule-covered ones.
   *
   * The `EXISTS` clause is what makes a send die with its file: a `device_pin`
   * row naming a book no folder holds any more is not a book anybody can be
   * given, and the model says a file removed from the folder is removed from
   * the device. Enforcing it here rather than only in `reconcile()` means it
   * takes effect on the next sync instead of the next restart.
   */
  idsForDevice(libraryIds: string[], pinnedIds: string[]): string[] {
    if (!libraryIds.length && !pinnedIds.length) return [];
    const libHoles = libraryIds.map(() => "?").join(",");
    const pinHoles = pinnedIds.map(() => "?").join(",");
    const clauses: string[] = [];
    if (libraryIds.length) {
      clauses.push(`b.id IN (SELECT book_id FROM library_book WHERE library_id IN (${libHoles}))`);
    }
    if (pinnedIds.length) {
      clauses.push(
        `(b.id IN (${pinHoles}) AND EXISTS (SELECT 1 FROM library_book WHERE book_id = b.id))`,
      );
    }
    return this.db.all<{ id: string }>(
      `SELECT b.id FROM book b
       WHERE ${clauses.join(" OR ")}
       ORDER BY b.title COLLATE NOCASE`,
      ...libraryIds,
      ...pinnedIds,
    ).map((r) => r.id);
  }

  /**
   * Where each of these books actually sits on disk — what the device layout
   * mirrors (`devicePlacements()`).
   *
   * A book can be in several folders at once; the answer has to be the same on
   * every sync or the file would move around the reader, so the rows are
   * ordered and the first one wins rather than whichever the query happened to
   * return.
   *
   * `preferLibraryIds` biases that tiebreak towards the folders a rule already
   * covers, but does **not** filter: a book sent by hand out of a folder no
   * rule covers still has to be filed under *that* folder's name on the reader,
   * or it lands at the upload root. Placing it where a rule would put it
   * anyway is what makes adding the rule later a no-op instead of a
   * send-then-delete for every book already up there.
   */
  sourcePathsFor(
    bookIds: string[],
    preferLibraryIds: string[] = [],
  ): Map<string, { libraryId: string; path: string }> {
    const out = new Map<string, { libraryId: string; path: string }>();
    if (!bookIds.length) return out;
    const preferred = new Set(preferLibraryIds);
    const holes = bookIds.map(() => "?").join(",");
    for (
      const row of this.db.all<{ book_id: string; library_id: string; path: string }>(
        `SELECT book_id, library_id, path FROM library_book
         WHERE book_id IN (${holes})
         ORDER BY library_id, path`,
        ...bookIds,
      )
    ) {
      const held = out.get(row.book_id);
      // First row wins, except that a preferred folder displaces a non-preferred
      // one — so a book in both a rule folder and another folder files under the
      // rule's, which is where the rest of that reader's books already are.
      if (held && (preferred.has(held.libraryId) || !preferred.has(row.library_id))) continue;
      out.set(row.book_id, { libraryId: row.library_id, path: row.path });
    }
    return out;
  }

  /**
   * Which folders hold these books. The sync's unreadable-folder guard needs it:
   * a book sent by hand out of a folder on an unmounted drive must abort the run
   * for the same reason a rule folder does, and the rule folders alone do not
   * name it.
   */
  librariesHolding(bookIds: string[]): string[] {
    if (!bookIds.length) return [];
    const holes = bookIds.map(() => "?").join(",");
    return this.db.all<{ library_id: string }>(
      `SELECT DISTINCT library_id FROM library_book WHERE book_id IN (${holes})`,
      ...bookIds,
    ).map((r) => r.library_id);
  }

  /**
   * The same relation, kept per book. The sync loop re-checks every book against
   * the rules still in force, and a book held by two folders must survive one of
   * them being unbound mid-run — which the collapsed form above cannot express.
   */
  libraryIdsByBook(bookIds: string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!bookIds.length) return out;
    const holes = bookIds.map(() => "?").join(",");
    for (
      const row of this.db.all<{ book_id: string; library_id: string }>(
        `SELECT book_id, library_id FROM library_book WHERE book_id IN (${holes})`,
        ...bookIds,
      )
    ) {
      const set = out.get(row.book_id);
      if (set) set.add(row.library_id);
      else out.set(row.book_id, new Set([row.library_id]));
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
