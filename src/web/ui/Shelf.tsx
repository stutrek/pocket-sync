// The shelf: headed sections of covers, whatever the sections happen to be.
//
// It knows nothing about scopes or bindings any more. It is handed groups
// (`grouping.ts`) and the reader a Send button means, and renders them — which
// is what lets the library, a person and a reader all use it while each showing
// its own contents.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import type { Group } from "./grouping.ts";
import {
  detailBookId,
  devices,
  folderOpen,
  loadBooks,
  loadInbox,
  loadStatus,
  progress,
  query,
  readingFilter,
  selection,
  selectMode,
  send,
  setFolderOpen,
  toast,
  toggleSelected,
} from "./store.ts";
import type { LibraryBook } from "./types.ts";

/**
 * How a book stands with the reader the view is about.
 *
 * "there by rule" and "sent by hand" both mean the book is on the reader, and
 * they look identical — but only one of them can be undone from here. Collapsing
 * them would put an un-send button on a book a folder rule would immediately put
 * back, which is the sort of thing that teaches people not to trust a control.
 */
export type Standing = "absent" | "sending" | "queued" | "byRule" | "byHand";

export function standingOf(
  book: LibraryBook,
  deviceId: string | null,
  uploading: boolean,
): Standing {
  if (!deviceId) return "absent";
  const on = book.onDevices.includes(deviceId);
  const byHand = book.pinnedTo.includes(deviceId);
  if (uploading) return "sending";
  if (on) return byHand ? "byHand" : "byRule";
  return byHand ? "queued" : "absent";
}

export interface ShelfProps {
  groups: Group[];
  /** The reader a Send button acts on. Null when there is none to send to. */
  target: string | null;
  /** Shown when there are no groups at all — each scope has its own reason. */
  empty?: ComponentChildren;
}

export function Shelf({ groups, target, empty }: ShelfProps) {
  const [hot, setHot] = useState<string | null>(null);

  // While searching or filtering, a collapsed group would hide its own matches,
  // so groups open themselves and empty ones drop out of the way entirely.
  const filtering = query.value !== "" || readingFilter.value !== "all";
  const shown = filtering ? groups.filter((g) => g.books.length) : groups;

  if (!groups.length) return <>{empty}</>;
  if (!shown.length) {
    return <p class="empty">Nothing matches. Clear the search or the reading filter.</p>;
  }

  return (
    <div class="shelf">
      {shown.map((group) => {
        const open = folderOpen.value[group.key] ??
          (filtering || !group.closedByDefault);

        return (
          <section
            key={group.key}
            class={`folder-group${hot === group.key ? " hot" : ""}`}
            onDragEnter={group.dropTo
              ? (e) => {
                e.preventDefault();
                setHot(group.key);
              }
              : undefined}
            onDragOver={group.dropTo
              ? (e) => {
                e.preventDefault();
                setHot(group.key);
              }
              : undefined}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setHot(null);
            }}
            onDrop={group.dropTo
              ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                setHot(null);
                uploadTo(group.dropTo!, Array.from(e.dataTransfer?.files ?? []));
              }
              : undefined}
          >
            <GroupHead group={group} open={open} />

            {open && (
              group.books.length
                ? (
                  <div class="grid">
                    {group.books.map((book) => <Card key={book.id} book={book} target={target} />)}
                  </div>
                )
                : (
                  <p class="muted small">
                    {group.dropTo
                      ? "Nothing here yet — drop books onto this folder to add."
                      : "Nothing here yet."}
                  </p>
                )
            )}

            {hot === group.key && <div class="drop-overlay">{`Add to ${group.label}`}</div>}
          </section>
        );
      })}
    </div>
  );
}

function GroupHead({ group, open }: { group: Group; open: boolean }) {
  return (
    <header class="folder-head">
      <button
        type="button"
        class="link caret"
        onClick={() => setFolderOpen(group.key, !open)}
      >
        {open ? "▾" : "▸"} {group.label}
      </button>
      <span class="muted small">{group.books.length}</span>
      {group.hint && <span class="muted small">{group.hint}</span>}
    </header>
  );
}

/**
 * Books land in a folder, never in "the library" — so when the shelf is grouped
 * by folder the section itself is the drop target and there is nothing to guess
 * about where they go. Other groupings have no folder under the cursor, and the
 * strip above the shelf asks instead.
 */
export async function uploadTo(libraryId: string, files: File[]) {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("file", file, file.name);
  try {
    await api("POST", `/api/books?library=${encodeURIComponent(libraryId)}`, form, true);
    // The scanner picks them up from the folder; the Inbox reports progress.
    await Promise.all([loadInbox(), loadBooks(), loadStatus()]);
  } catch (err) {
    toast(errText(err), "error");
  }
}

export function Card({ book, target }: { book: LibraryBook; target: string | null }) {
  const isSelected = selection.value.has(book.id);
  const pct = progress.value.get(book.id);
  const open = () => (detailBookId.value = book.id);
  const readPct = Math.round((book.percentage ?? 0) * 100);
  const standing = standingOf(book, target, pct !== undefined);
  const reader = devices.value.find((d) => d.id === target);
  const name = reader?.name || reader?.model || "this reader";

  return (
    <div class={`card${isSelected ? " selected" : ""}`}>
      {selectMode.value
        ? (
          <input
            type="checkbox"
            title="Select"
            checked={isSelected}
            onChange={(e) => toggleSelected(book.id, e.currentTarget.checked)}
          />
        )
        : target && <SendButton book={book} target={target} name={name} standing={standing} />}
      <div class="cover" onClick={open}>
        <span
          class={`sync-dot ${dotClass(standing)}`}
          title={hint(standing, name, pct)}
          aria-label={hint(standing, name, pct)}
        />
        {book.hasCover
          ? <img src={`/api/books/${book.id}/cover`} alt="" loading="lazy" />
          : <span class="placeholder">📖</span>}
        {readPct > 0 && !book.finished && (
          <div class="read-bar" title={`${readPct}% read`}>
            <div style={{ width: `${readPct}%` }} />
          </div>
        )}
      </div>
      <div class="meta" onClick={open}>
        <div class="title" title={book.title}>{book.title}</div>
        <div class="author">{book.author}</div>
        {/* Where it is lives in the dot; this line is only about reading. */}
        <div class="badges">
          {book.finished
            ? <span class="badge finished">finished</span>
            : readPct > 0 && <span class="badge">{`${readPct}%`}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The whole point of the redesign in one control: one book, one reader, one
 * click.
 *
 * A book carried because of a folder rule renders as a state, not a button —
 * un-sending it would do nothing, because the rule would put it back on the next
 * sync. The rule is named in the tooltip so the answer to "why can't I remove
 * this" is in the same place as the question.
 */
function SendButton(
  { book, target, name, standing }: {
    book: LibraryBook;
    target: string;
    name: string;
    standing: Standing;
  },
) {
  if (standing === "byRule") {
    return (
      <span class="send-mark rule" title={`On ${name} — a folder rule syncs it there`}>✓</span>
    );
  }
  const on = standing === "byHand" || standing === "queued" || standing === "sending";
  return (
    <button
      type="button"
      class={`send-mark${on ? " on" : ""}`}
      title={hint(standing, name)}
      aria-label={hint(standing, name)}
      onClick={(e) => {
        e.stopPropagation();
        send(target, [book.id], !on);
      }}
    >
      {on ? "✓" : "＋"}
    </button>
  );
}

const dotClass = (s: Standing) =>
  s === "sending"
    ? "pending sending"
    : s === "queued"
    ? "pending"
    : s === "absent"
    ? "unsynced"
    : "synced";

function hint(standing: Standing, name: string, pct?: number): string {
  switch (standing) {
    case "sending":
      return `Sending to ${name} — ${Math.round((pct ?? 0) * 100)}%`;
    case "queued":
      return `Will send when ${name} is next awake`;
    case "byRule":
      return `On ${name} — a folder rule syncs it there`;
    case "byHand":
      return `On ${name} — sent by you. Click to take it off.`;
    case "absent":
      return `Send to ${name}`;
  }
}
