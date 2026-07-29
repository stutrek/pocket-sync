// One person: what they are reading, what their readers carry, and their
// page-sync login.
//
// This page used to be the whole library with a half-ticked box on every folder
// — a bulk edit disguised as a shelf, which docs/DESIGN.md already flagged as
// uncomfortable. Folder rules belong to a reader, so they are set on the
// reader's page; this page is about the person.
import { useState } from "preact/hooks";
import { api } from "./api.ts";
import { groupsFor } from "./grouping.ts";
import { Shelf } from "./Shelf.tsx";
import { books, devices, groupBy, libraries, loadUsers, setScope, users } from "./store.ts";

export function UserView({ id, target }: { id: string; target: string | null }) {
  const [renaming, setRenaming] = useState(false);
  const user = users.value.find((u) => u.id === id);
  if (!user) return <p class="empty">This person is no longer listed.</p>;

  const theirs = devices.value.filter((d) => user.deviceIds.includes(d.id));
  const defaultServer = user.syncServers?.find((s) => s.id === user.defaultSyncServerId);

  const present = new Set(books.value.map((b) => b.library_id));
  const folders = libraries.value.filter((l) => present.has(l.id));
  const groups = groupsFor(books.value, folders, groupBy.value);

  return (
    <div class="scope-view">
      <header class="scope-head">
        {renaming
          ? (
            <input
              value={user.name}
              autoFocus
              onBlur={async (e) => {
                setRenaming(false);
                const next = e.currentTarget.value.trim();
                if (next && next !== user.name) {
                  await api("PUT", `/api/users/${user.id}`, { name: next });
                  loadUsers();
                }
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )
          : <h2 onClick={() => setRenaming(true)} title="Click to rename">{user.name}</h2>}
        <span class="spacer" />
        {theirs.length
          ? theirs.map((d) => (
            <button
              key={d.id}
              type="button"
              class="link"
              onClick={() => setScope({ kind: "device", id: d.id })}
            >
              <span class={`dot${d.state.online ? " ok" : ""}`} />
              {d.name || d.model || d.id}
            </button>
          ))
          : <span class="muted small">no reader assigned</span>}
      </header>

      {
        /* The login shown has to be the one for the server their readers
          actually use, not ours — a household member reporting to their own
          sync server would otherwise be handed credentials that do not work
          there. */
      }
      {defaultServer && (
        <p class="muted small">
          Page-sync login on <strong>{defaultServer.name}</strong>:{" "}
          <code>{defaultServer.username || "—"}</code> <code>{defaultServer.password || "—"}</code>
          {" "}
          — the full list is under <strong>Settings → Page sync</strong>.
        </p>
      )}

      <Shelf
        groups={groups}
        target={target}
        empty={
          <p class="empty">
            {theirs.length ? <>Nothing on {user.name}'s readers yet, and nothing started.</> : (
              <>
                {user.name} has no reader yet. Open one under <strong>Unassigned readers</strong>
                {" "}
                and set them as its holder.
              </>
            )}
          </p>
        }
      />
    </div>
  );
}
