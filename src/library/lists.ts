import type { Db } from "../core/db.ts";
import { newId } from "../core/ids.ts";

export interface BookList {
  id: string;
  name: string;
  created_at: string;
  count?: number;
}

export class Lists {
  constructor(private readonly db: Db) {}

  all(): BookList[] {
    return this.db.all<BookList>(
      `SELECT l.*, (SELECT COUNT(*) FROM list_item li WHERE li.list_id = l.id) AS count
       FROM "list" l ORDER BY l.name COLLATE NOCASE`,
    );
  }

  get(id: string): BookList | undefined {
    return this.db.get<BookList>('SELECT * FROM "list" WHERE id = ?', id);
  }

  create(name: string): BookList {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("List name is required");
    const id = newId();
    this.db.run(
      'INSERT INTO "list" (id, name, created_at) VALUES (?, ?, ?)',
      id,
      trimmed,
      new Date().toISOString(),
    );
    return this.get(id)!;
  }

  rename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("List name is required");
    this.db.run('UPDATE "list" SET name = ? WHERE id = ?', trimmed, id);
  }

  remove(id: string) {
    this.db.run('DELETE FROM "list" WHERE id = ?', id);
  }

  addItems(listId: string, bookIds: string[]) {
    const next = this.db.get<{ n: number }>(
      "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM list_item WHERE list_id = ?",
      listId,
    )!.n;
    this.db.tx(() => {
      bookIds.forEach((bookId, i) => {
        this.db.run(
          `INSERT INTO list_item (list_id, book_id, position) VALUES (?, ?, ?)
           ON CONFLICT (list_id, book_id) DO NOTHING`,
          listId,
          bookId,
          next + i,
        );
      });
    });
  }

  removeItems(listId: string, bookIds: string[]) {
    this.db.tx(() => {
      for (const bookId of bookIds) {
        this.db.run("DELETE FROM list_item WHERE list_id = ? AND book_id = ?", listId, bookId);
      }
    });
  }

  /** Persist an explicit ordering (array of book ids). */
  reorder(listId: string, bookIds: string[]) {
    this.db.tx(() => {
      bookIds.forEach((bookId, i) => {
        this.db.run(
          "UPDATE list_item SET position = ? WHERE list_id = ? AND book_id = ?",
          i,
          listId,
          bookId,
        );
      });
    });
  }
}
