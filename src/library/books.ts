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
  original_path: string;
  original_ext: string;
  epub_path: string | null;
  size_bytes: number;
  meta_json: string;
}

export interface BookQuery {
  query?: string;
  listId?: string;
  limit?: number;
  offset?: number;
}

export class Books {
  constructor(private readonly db: Db, private readonly paths: Paths) {}

  list(q: BookQuery = {}): Book[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    let from = "book b";
    if (q.listId) {
      from += " JOIN list_item li ON li.book_id = b.id AND li.list_id = ?";
      params.push(q.listId);
    }
    if (q.query?.trim()) {
      where.push("(b.title LIKE ? OR b.author LIKE ? OR b.series LIKE ?)");
      const like = `%${q.query.trim()}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT b.* FROM ${from}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${q.listId ? "li.position, " : ""}b.title COLLATE NOCASE
      LIMIT ? OFFSET ?`;
    params.push(q.limit ?? 5000, q.offset ?? 0);
    return this.db.all<Book>(sql, ...params);
  }

  get(id: string): Book | undefined {
    return this.db.get<Book>("SELECT * FROM book WHERE id = ?", id);
  }

  ids(): string[] {
    return this.db.all<{ id: string }>("SELECT id FROM book").map((r) => r.id);
  }

  /** Book ids for a sync rule source. */
  idsForSource(sourceType: string, listId: string | null): string[] {
    if (sourceType === "list" && listId) {
      return this.db.all<{ book_id: string }>(
        "SELECT book_id FROM list_item WHERE list_id = ? ORDER BY position",
        listId,
      ).map((r) => r.book_id);
    }
    return this.db.all<{ id: string }>("SELECT id FROM book ORDER BY title COLLATE NOCASE")
      .map((r) => r.id);
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

  /** Remove a book row plus its on-disk artifacts. Device rows cascade. */
  remove(id: string) {
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

  listsFor(bookId: string) {
    return this.db.all<{ id: string; name: string }>(
      `SELECT l.id, l.name FROM "list" l
       JOIN list_item li ON li.list_id = l.id
       WHERE li.book_id = ? ORDER BY l.name COLLATE NOCASE`,
      bookId,
    );
  }
}
