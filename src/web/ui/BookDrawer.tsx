import { useEffect, useState } from "preact/hooks";
import { api, errText, fmtBytes, fmtDate } from "./api.ts";
import { detailBookId, loadBooks, toast } from "./store.ts";
import type { BookDetail } from "./types.ts";

/** Slide-over detail panel. Mounted only while `detailBookId` is set. */
export function BookDrawer({ id }: { id: string }) {
  const [book, setBook] = useState<BookDetail | null>(null);
  const close = () => (detailBookId.value = null);

  const reload = () =>
    api<BookDetail>("GET", `/api/books/${id}`)
      .then(setBook)
      .catch((err) => {
        toast(errText(err), "error");
        close();
      });

  useEffect(() => {
    let cancelled = false;
    setBook(null);
    api<BookDetail>("GET", `/api/books/${id}`)
      .then((b) => !cancelled && setBook(b))
      .catch((err) => {
        toast(errText(err), "error");
        close();
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!book) {
    return (
      <div class="drawer">
        <button type="button" onClick={close}>Close</button>
        <p class="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div class="drawer">
      <button type="button" onClick={close}>Close</button>
      <h2>{book.title}</h2>
      {book.hasCover && <img class="cover-large" src={`/api/books/${id}/cover`} alt="" />}
      <dl>
        <dt>Author</dt>
        <dd>{book.author}</dd>
        {book.series && <dt>Series</dt>}
        {book.series && (
          <dd>{`${book.series}${book.series_index ? ` #${book.series_index}` : ""}`}</dd>
        )}
        <dt>Added</dt>
        <dd>{new Date(book.added_at).toLocaleString()}</dd>
        <dt>Source</dt>
        <dd>{`${book.original_ext.toUpperCase()} · ${fmtBytes(book.size_bytes)}`}</dd>
        <dt>EPUB</dt>
        <dd>{book.epubSize ? fmtBytes(book.epubSize) : "—"}</dd>
        <dt>Devices</dt>
        <dd>
          {book.devices.length
            ? book.devices.map((d) => (
              <div key={d.device_id}>
                {`${d.name || d.device_id} · ${fmtDate(d.synced_at)}`}
              </div>
            ))
            : <span>—</span>}
        </dd>
      </dl>

      <div class="drawer-lib">
        <div class="muted">In folders</div>
        {book.libraries.map((lib) => (
          <div key={lib.library_id} class="muted small" title={lib.path}>
            {lib.name} — {lib.path}
          </div>
        ))}
      </div>

      {book.reading.map((r) => (
        <div key={r.userId} class="drawer-lib">
          <div class="muted">{r.name}</div>
          <Reading bookId={id} userId={r.userId} state={r.state} onChange={reload} />
        </div>
      ))}

      <div class="toolbar" style="margin-top:12px">
        <button
          type="button"
          onClick={async () => {
            await api("POST", `/api/books/${id}/resend`);
            toast("Marked for re-send", "ok");
            close();
            loadBooks();
          }}
        >
          Re-send on next sync
        </button>
        {
          /* Books that exist only in a read-only source are not ours to delete:
            the file belongs to the app that made it, and the endpoint refuses. */
        }
        {book.libraries.some((l) => !l.readOnly)
          ? (
            <button
              type="button"
              class="danger"
              onClick={async () => {
                if (
                  !confirm(
                    `Delete “${book.title}”? This deletes the file from your watched folder.`,
                  )
                ) return;
                await api("DELETE", `/api/books/${id}`);
                close();
                toast("Deleted", "ok");
                loadBooks();
              }}
            >
              Delete file
            </button>
          )
          : (
            <span class="muted small">
              Lives in a read-only source — delete it in the app that owns it.
            </span>
          )}
      </div>
    </div>
  );
}

/**
 * Progress comes from the reader's KOReader sync, which the user triggers by
 * hand — so show when it was last heard rather than implying live tracking.
 */
function Reading(
  { bookId, userId, state, onChange }: {
    bookId: string;
    userId: string;
    state: BookDetail["reading"][number]["state"];
    onChange: () => void;
  },
) {
  const pct = Math.round((state?.percentage ?? 0) * 100);
  const finished = !!state?.finished;

  return (
    <div class="reading">
      <label>
        <input
          type="checkbox"
          checked={finished}
          onChange={async (e) => {
            await api("PUT", `/api/books/${bookId}/finished`, {
              userId,
              finished: e.currentTarget.checked,
            });
            onChange();
            loadBooks();
          }}
        />
        Finished
      </label>
      <span class="muted">
        {state?.updated_at
          ? `${pct}% · reported ${fmtDate(state.updated_at)}${
            state.finished_source === "manual" ? " · set by you" : ""
          }`
          : "no progress reported yet"}
      </span>
    </div>
  );
}
