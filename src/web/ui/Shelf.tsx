// The shelf: every watched folder as a collapsible section of covers. All three
// scopes — the whole library, a person, a reader — render this same component,
// because they differ only in which folders are bound and who is reading.
import { useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import {
  books,
  detailBookId,
  devices,
  folderOpen,
  loadBooks,
  loadInbox,
  loadStatus,
  progress,
  query,
  readingFilter,
  scope,
  selection,
  selectMode,
  setFolderOpen,
  toast,
  toggleSelected,
  users,
} from "./store.ts";
import type { Library, LibraryBook } from "./types.ts";

/** Tri-state because a person's folder may reach only some of their readers. */
export type Bound = "on" | "off" | "partial";

/**
 * A book's standing with the readers this view is about: already there, on its
 * way, or going nowhere. Which readers those are depends on the scope — one
 * reader's page asks about that reader, a person's page about theirs, and the
 * whole library about every reader the folder feeds.
 */
type Sync = "synced" | "pending" | "unsynced";

function targetsFor(folder: Library): string[] {
  const s = scope.value;
  if (s.kind === "device") return folder.deviceIds.includes(s.id) ? [s.id] : [];
  if (s.kind === "user") {
    const held = users.value.find((u) => u.id === s.id)?.deviceIds ?? [];
    return folder.deviceIds.filter((id) => held.includes(id));
  }
  return folder.deviceIds;
}

function syncState(book: LibraryBook, targets: string[]): Sync {
  if (!targets.length) return "unsynced";
  return targets.every((id) => book.onDevices.includes(id)) ? "synced" : "pending";
}

export interface ShelfProps {
  folders: Library[];
  /** Omitted in the whole-library view, which binds nothing. */
  binding?: {
    state: (folder: Library) => Bound;
    toggle: (folder: Library, on: boolean) => void | Promise<void>;
    /** Set when ticking would have nowhere to write — shown instead of a checkbox. */
    disabledReason?: string;
    label: string;
  };
}

export function Shelf({ folders, binding }: ShelfProps) {
  const [hot, setHot] = useState<string | null>(null);

  // While searching or filtering, a collapsed folder would hide its own matches,
  // so groups open themselves and empty ones drop out of the way entirely.
  const filtering = query.value !== "" || readingFilter.value !== "all";

  const grouped = new Map<string, LibraryBook[]>();
  for (const book of books.value) {
    const list = grouped.get(book.library_id);
    if (list) list.push(book);
    else grouped.set(book.library_id, [book]);
  }

  if (!folders.length) return null;

  // Filtering hides whole folders, so with no matches left there would be
  // nothing on screen at all to say what happened.
  const shown = filtering ? folders.filter((f) => grouped.has(f.id)) : folders;
  if (!shown.length) {
    return <p class="empty">Nothing matches. Clear the search or the reading filter.</p>;
  }

  return (
    <div class="shelf">
      {shown.map((folder) => {
        const rows = grouped.get(folder.id) ?? [];
        const state = binding?.state(folder) ?? "on";
        const targets = targetsFor(folder);
        // An unticked folder is reference material here, not the point of the
        // view, so it starts out of the way — until the user says otherwise.
        const open = folderOpen.value[folder.id] ?? (filtering || state !== "off");

        return (
          <section
            key={folder.id}
            class={`folder-group${state === "off" ? " unbound" : ""}${
              hot === folder.id ? " hot" : ""
            }`}
            onDragEnter={(e) => {
              e.preventDefault();
              setHot(folder.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setHot(folder.id);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setHot(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setHot(null);
              uploadTo(folder.id, Array.from(e.dataTransfer?.files ?? []));
            }}
          >
            <FolderHead
              folder={folder}
              count={rows.length}
              open={open}
              binding={binding}
              state={state}
            />

            {open && (
              rows.length
                ? (
                  <div class="grid">
                    {rows.map((book) => (
                      <Card key={book.id} book={book} sync={syncState(book, targets)} />
                    ))}
                  </div>
                )
                : <p class="muted small">Nothing here yet — drop books onto this folder to add.</p>
            )}

            {hot === folder.id && <div class="drop-overlay">{`Add to ${folder.name}`}</div>}
          </section>
        );
      })}
    </div>
  );
}

function FolderHead(
  { folder, count, open, binding, state }: {
    folder: Library;
    count: number;
    open: boolean;
    binding?: ShelfProps["binding"];
    state: Bound;
  },
) {
  const readers = devices.value.filter((d) => folder.deviceIds.includes(d.id));

  return (
    <header class="folder-head">
      <button
        type="button"
        class="link caret"
        title={folder.path}
        onClick={() => setFolderOpen(folder.id, !open)}
      >
        {open ? "▾" : "▸"} {folder.name}
      </button>
      <span class="muted small">{count}</span>

      {!binding && readers.length > 0 && (
        <span class="muted small">
          {`→ ${readers.map((d) => d.name || d.model || d.id).join(", ")}`}
        </span>
      )}

      <span class="spacer" />

      {binding && (
        binding.disabledReason
          ? <span class="muted small">{binding.disabledReason}</span>
          : (
            <label class="check">
              <input
                type="checkbox"
                checked={state === "on"}
                // Half-ticked has no HTML attribute, only a DOM property.
                ref={(el) => {
                  if (el) el.indeterminate = state === "partial";
                }}
                onChange={(e) => binding.toggle(folder, e.currentTarget.checked)}
              />
              {binding.label}
            </label>
          )
      )}
    </header>
  );
}

/**
 * Books land in a folder, never in "the library" — so the drop target is the
 * folder section itself and there is nothing to guess about where they go.
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

const deviceNames = (ids: string[]) =>
  ids.map((id) => {
    const d = devices.value.find((x) => x.id === id);
    return d?.name || d?.model || id;
  }).join(", ");

export function Card({ book, sync }: { book: LibraryBook; sync: Sync }) {
  const isSelected = selection.value.has(book.id);
  const pct = progress.value.get(book.id);
  const open = () => (detailBookId.value = book.id);
  const readPct = Math.round((book.percentage ?? 0) * 100);
  // Actively uploading is still "on its way", just visibly so.
  const sending = pct !== undefined;
  const where = book.onDevices.length ? ` (on ${deviceNames(book.onDevices)})` : "";
  const hint = sending
    ? `Sending — ${Math.round((pct ?? 0) * 100)}%`
    : sync === "synced"
    ? `On your reader${where}`
    : sync === "pending"
    ? `Waiting to send${where}`
    : `Not set to sync to any reader${where}`;

  return (
    <div class={`card${isSelected ? " selected" : ""}`}>
      {selectMode.value && (
        <input
          type="checkbox"
          title="Select"
          checked={isSelected}
          onChange={(e) => toggleSelected(book.id, e.currentTarget.checked)}
        />
      )}
      <div class="cover" onClick={open}>
        {
          /* One glyph per book instead of a row of names — at this size the
            question is only ever "is it on my reader?" */
        }
        <span
          class={`sync-dot ${sending ? "pending sending" : sync}`}
          title={hint}
          aria-label={hint}
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
        {
          /* Where it is now lives in the dot on the cover; this line is only
            about reading. */
        }
        <div class="badges">
          {book.finished
            ? <span class="badge finished">finished</span>
            : readPct > 0 && <span class="badge">{`${readPct}%`}</span>}
        </div>
      </div>
    </div>
  );
}
