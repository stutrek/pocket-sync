// The whole app's home: the library, then the people it is for, then their
// readers. Each level shows *its own* books — a person's page is their pile,
// a reader's page is what that reader is carrying — rather than the whole
// library with a different checkbox on every folder.
import { useEffect, useMemo, useState } from "preact/hooks";
import { ActivityBar } from "./ActivityBar.tsx";
import { AddBooks } from "./AddBooks.tsx";
import { api } from "./api.ts";
import { Select } from "./components.tsx";
import { DeviceView } from "./DeviceView.tsx";
import { groupsFor } from "./grouping.ts";
import { NewReaders } from "./NewReaders.tsx";
import { AddPerson } from "./People.tsx";
import { Shelf, uploadTo } from "./Shelf.tsx";
import { UserView } from "./UserView.tsx";
import {
  books,
  clearSelection,
  devices,
  dropTo,
  groupBy,
  libraries,
  loadBooks,
  loadLibraries,
  loadStatus,
  loadUsers,
  query,
  readingFilter,
  resolveTarget,
  scope,
  selection,
  selectMode,
  send,
  setDropTo,
  setGroupBy,
  setScope,
  setTarget,
  toast,
  users,
} from "./store.ts";
import type { Device, GroupBy, ReadingFilter, Scope } from "./types.ts";

const FILTERS: [ReadingFilter, string][] = [
  ["all", "All"],
  ["reading", "Reading"],
  ["unread", "Unread"],
  ["finished", "Finished"],
];

const GROUPINGS: [GroupBy, string][] = [
  ["folder", "Folder"],
  ["author", "Author"],
  ["series", "Series"],
  ["recent", "Recently added"],
];

export function Library() {
  useEffect(() => {
    loadLibraries();
    loadUsers();
  }, []);

  // The search box is uncontrolled so typing stays responsive; only the
  // debounced value reaches the server.
  const onSearch = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (value: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        query.value = value;
        loadBooks();
      }, 250);
    };
  }, []);

  const current = scope.value;
  const target = resolveTarget();

  return (
    <section class="view">
      <div class="split">
        <Rail />

        <div class="pane grow">
          <Toolbar target={target} onSearch={onSearch} />
          <ActivityBar />
          <NewReaders />

          {current.kind === "user"
            ? <UserView id={current.id} target={target} />
            : current.kind === "device"
            ? <DeviceView id={current.id} />
            : <Everything target={target} />}
        </div>
      </div>
    </section>
  );
}

/**
 * Search, where a send goes, and how the shelf is carved up.
 *
 * The send target lives here rather than on each card because a per-card reader
 * menu asks the same question hundreds of times when the answer changes about
 * once a week — and because with one target the dot on every cover has exactly
 * one meaning.
 */
function Toolbar(
  { target, onSearch }: { target: string | null; onSearch: (v: string) => void },
) {
  const selected = selection.value;
  const hasSelection = selected.size > 0;
  const reader = devices.value.find((d) => d.id === target);
  const readerName = reader?.name || reader?.model || "";
  const locked = scope.value.kind === "device";

  return (
    <div class="toolbar">
      <input
        type="search"
        placeholder="Search title, author, series…"
        autocomplete="off"
        onInput={(e) => onSearch(e.currentTarget.value)}
      />

      <span class="sending-to">
        {!devices.value.length ? <span class="muted small">No reader yet</span> : locked
          // On a reader's own page there is nothing to choose: you are looking
          // at the destination.
          ? <span class="muted small">{`Sending to ${readerName}`}</span>
          : (
            <>
              <span class="muted small">Sending to</span>
              <Select
                value={target ?? ""}
                options={devices.value.map((d): [string, string] => [
                  d.id,
                  d.name || d.model || d.id,
                ])}
                onChange={(v) => setTarget(v)}
              />
            </>
          )}
      </span>

      <span class="muted small">Group by</span>
      <Select
        value={groupBy.value}
        options={GROUPINGS}
        onChange={(v) => setGroupBy(v as GroupBy)}
      />

      <span class="spacer" />

      {hasSelection && <span class="muted">{`${selected.size} selected`}</span>}
      {hasSelection && target && (
        <button
          type="button"
          class="primary"
          onClick={async () => {
            await send(target, [...selected], true);
            clearSelection();
          }}
        >
          {`Send ${selected.size} to ${readerName}`}
        </button>
      )}
      {hasSelection && (
        <button
          type="button"
          class="danger"
          onClick={async () => {
            if (
              !confirm(`Delete ${selected.size} book(s)? This deletes the files from your folder.`)
            ) return;
            for (const id of selected) await api("DELETE", `/api/books/${id}`);
            clearSelection();
            toast("Deleted", "ok");
            loadBooks();
            loadStatus();
          }}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        class={selectMode.value ? "active" : ""}
        onClick={() => {
          selectMode.value = !selectMode.value;
          if (!selectMode.value) clearSelection();
        }}
      >
        Select
      </button>
    </div>
  );
}

/** The library itself: every watched folder, with nothing bound to anything. */
function Everything({ target }: { target: string | null }) {
  const folders = libraries.value;

  const groups = groupsFor(books.value, folders, groupBy.value, (folder) => {
    const readers = devices.value.filter((d) => folder.deviceIds.includes(d.id));
    return readers.length
      ? `→ ${readers.map((d) => d.name || d.model || d.id).join(", ")}`
      : undefined;
  });

  return (
    <div class="scope-view">
      <DropStrip />
      <Shelf
        groups={groups}
        target={target}
        empty={
          <p class="empty">
            No books yet. <strong>Add books</strong>{" "}
            in the sidebar to watch a folder, then send them to a reader.
          </p>
        }
      />
    </div>
  );
}

/**
 * Where a drop lands when there is no folder under the cursor.
 *
 * Always visible rather than revealed on dragenter: a hidden drop target is how
 * you get a drop that goes nowhere. Read-only sources are never offered — the
 * upload endpoint refuses them, and a control that cannot work is worse than no
 * control.
 */
export function DropStrip() {
  const writable = libraries.value.filter((l) => !l.external);
  if (groupBy.value === "folder" || !writable.length) return null;
  const chosen = writable.find((l) => l.id === dropTo.value)?.id ?? writable[0].id;

  return (
    <div class="drop-strip">
      <span class="muted small">Drop books here →</span>
      <Select
        value={chosen}
        options={writable.map((l): [string, string] => [l.id, l.name])}
        onChange={(v) => setDropTo(v)}
      />
      <DropZone libraryId={chosen} />
    </div>
  );
}

function DropZone({ libraryId }: { libraryId: string }) {
  const [hot, setHot] = useState(false);
  return (
    <label
      class={`dropzone${hot ? " hot" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setHot(true);
      }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setHot(false);
        uploadTo(libraryId, Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      <input
        type="file"
        multiple
        onChange={(e) => {
          uploadTo(libraryId, Array.from(e.currentTarget.files ?? []));
          e.currentTarget.value = "";
        }}
      />
      or choose files
    </label>
  );
}

/** Library, then each person, then the readers they hold. */
function Rail() {
  const all = scope.value;
  const [adding, setAdding] = useState<null | "books" | "person">(null);
  const claimed = new Set<string>();
  for (const u of users.value) for (const id of u.deviceIds) claimed.add(id);
  const unclaimed = devices.value.filter((d) => !claimed.has(d.id));
  const total = libraries.value.reduce((n, l) => n + l.books, 0);

  return (
    <div class="pane rail">
      <ul class="rail-list rail-tree">
        <li
          class={all.kind === "all" ? "active" : ""}
          onClick={() => setScope({ kind: "all" })}
        >
          <span>Library</span>
          <span class="muted">{total}</span>
        </li>

        {users.value.map((u) => (
          <li key={u.id} class="rail-person">
            <div
              class={isScope(all, "user", u.id) ? "rail-row active" : "rail-row"}
              onClick={() => setScope({ kind: "user", id: u.id })}
            >
              <span>{u.name}</span>
              {u.deviceIds.length === 0 && <span class="muted small">no reader</span>}
            </div>
            <ul class="rail-list">
              {u.deviceIds.map((id) => {
                const d = devices.value.find((x) => x.id === id);
                return d ? <RailDevice key={id} device={d} scope={all} /> : null;
              })}
            </ul>
          </li>
        ))}

        {unclaimed.length > 0 && (
          <li class="rail-person">
            {
              /* A reader nobody holds still has to be reachable — there is no
                Devices tab left to find it on. */
            }
            <div class="rail-row muted">Unassigned readers</div>
            <ul class="rail-list">
              {unclaimed.map((d) => <RailDevice key={d.id} device={d} scope={all} />)}
            </ul>
          </li>
        )}
      </ul>

      {/* Getting books in and people named are library actions, not settings. */}
      <ul class="rail-list rail-actions">
        <li onClick={() => setAdding("books")}>
          <span class="link">+ Add books</span>
        </li>
        <li onClick={() => setAdding("person")}>
          <span class="link">+ Add person</span>
        </li>
      </ul>

      <ul class="rail-list">
        {FILTERS.map(([id, label]) => (
          <li
            key={id}
            class={readingFilter.value === id ? "active" : ""}
            onClick={() => {
              readingFilter.value = id;
              loadBooks();
            }}
          >
            <span>{label}</span>
          </li>
        ))}
      </ul>

      {adding === "books" && <AddBooks onClose={() => setAdding(null)} />}
      {adding === "person" && <AddPerson onClose={() => setAdding(null)} />}
    </div>
  );
}

function RailDevice({ device: d, scope: s }: { device: Device; scope: Scope }) {
  return (
    <li
      class={isScope(s, "device", d.id) ? "rail-device active" : "rail-device"}
      onClick={() => setScope({ kind: "device", id: d.id })}
    >
      <span class={`dot${d.state.online ? " ok" : ""}`} />
      <span class="name">{d.name || d.model || d.id}</span>
      <span class="spacer" />
      {d.plan.send > 0 && (
        <span class="badge" title={`${d.plan.send} book(s) to send`}>{`${d.plan.send}↑`}</span>
      )}
    </li>
  );
}

const isScope = (s: Scope, kind: Scope["kind"], id: string) =>
  s.kind === kind && "id" in s &&
  s.id === id;

/** Swallow stray drops so the browser doesn't navigate away from the app. */
export function useGlobalDropGuard() {
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("dragover", stop);
    document.addEventListener("drop", stop);
    return () => {
      document.removeEventListener("dragover", stop);
      document.removeEventListener("drop", stop);
    };
  }, []);
}
