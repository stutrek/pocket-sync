import { useEffect, useMemo } from "preact/hooks";
import { ActivityBar } from "./ActivityBar.tsx";
import { api } from "./api.ts";
import { DeviceView } from "./DeviceView.tsx";
import { Shelf } from "./Shelf.tsx";
import { UserView } from "./UserView.tsx";
import {
  clearSelection,
  devices,
  libraries,
  loadBooks,
  loadLibraries,
  loadStatus,
  loadUsers,
  query,
  readingFilter,
  scope,
  selection,
  selectMode,
  setScope,
  toast,
  users,
} from "./store.ts";
import type { Device, ReadingFilter, Scope } from "./types.ts";

const FILTERS: [ReadingFilter, string][] = [
  ["all", "All"],
  ["reading", "Reading"],
  ["unread", "Unread"],
  ["finished", "Finished"],
];

/**
 * The whole app's home: the library, then the people it is for, then their
 * readers. Picking any level shows the same shelf — what changes is which
 * folders are ticked to go there.
 */
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

  const selected = selection.value;
  const hasSelection = selected.size > 0;
  const current = scope.value;

  return (
    <section class="view">
      <div class="split">
        <Rail />

        <div class="pane grow">
          <div class="toolbar">
            <input
              type="search"
              placeholder="Search title, author, series…"
              autocomplete="off"
              onInput={(e) => onSearch(e.currentTarget.value)}
            />
            <span class="spacer" />
            {hasSelection && <span class="muted">{`${selected.size} selected`}</span>}
            {hasSelection && (
              <button
                type="button"
                class="danger"
                onClick={async () => {
                  if (
                    !confirm(
                      `Delete ${selected.size} book(s)? This deletes the files from your folder.`,
                    )
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

          <ActivityBar />

          {current.kind === "user"
            ? <UserView id={current.id} />
            : current.kind === "device"
            ? <DeviceView id={current.id} />
            : <AllFolders />}
        </div>
      </div>
    </section>
  );
}

/** The library itself: every folder, with no binding to edit. */
function AllFolders() {
  if (!libraries.value.length) {
    return (
      <p class="empty">
        No folders yet. Pick your books folder in <strong>Settings</strong>{" "}
        and tick the folders inside it you want synced.
      </p>
    );
  }
  return <Shelf folders={libraries.value} />;
}

/** Library, then each person, then the readers they hold. */
function Rail() {
  const all = scope.value;
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
