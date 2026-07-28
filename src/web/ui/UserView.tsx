// One person's shelf. Folder ticks here are a bulk edit across every reader
// they currently hold — the binding itself stays per device (docs/DESIGN.md),
// so a reader assigned to them later does not inherit anything.
import { api, errText } from "./api.ts";
import { Shelf } from "./Shelf.tsx";
import type { Bound } from "./Shelf.tsx";
import {
  devices,
  libraries,
  loadDevices,
  loadLibraries,
  loadUsers,
  setScope,
  toast,
  users,
} from "./store.ts";
import type { Library } from "./types.ts";

export function UserView({ id }: { id: string }) {
  const user = users.value.find((u) => u.id === id);
  if (!user) return <p class="empty">This person is no longer listed.</p>;

  const theirs = devices.value.filter((d) => user.deviceIds.includes(d.id));

  const state = (folder: Library): Bound => {
    if (!user.deviceIds.length) return "off";
    const on = user.deviceIds.filter((d) => folder.deviceIds.includes(d)).length;
    return on === 0 ? "off" : on === user.deviceIds.length ? "on" : "partial";
  };

  const defaultServer = user.syncServers?.find((s) => s.id === user.defaultSyncServerId);

  const toggle = async (folder: Library, on: boolean) => {
    const deviceIds = on
      ? [...new Set([...folder.deviceIds, ...user.deviceIds])]
      : folder.deviceIds.filter((d) => !user.deviceIds.includes(d));
    try {
      await api("PUT", `/api/libraries/${folder.id}`, { deviceIds });
      await Promise.all([loadLibraries(), loadDevices()]);
    } catch (err) {
      toast(errText(err), "error");
    }
  };

  return (
    <div class="scope-view">
      <header class="scope-head">
        <h2>{user.name}</h2>
        <span class="muted">
          {theirs.length
            ? theirs.map((d) => d.name || d.model || d.id).join(", ")
            : "no reader assigned"}
        </span>
        <span class="spacer" />
        <button
          type="button"
          onClick={async () => {
            const next = prompt("Name", user.name);
            if (!next?.trim()) return;
            await api("PUT", `/api/users/${user.id}`, { name: next.trim() });
            loadUsers();
          }}
        >
          Rename
        </button>
      </header>

      {
        /* The login shown has to be the one for the server their readers
          actually use, not ours — a household member reporting to their own
          sync server would otherwise be handed credentials that do not work
          there. */
      }
      <p class="muted small">
        Ticking a folder here sends it to{" "}
        {theirs.length > 1 ? `all ${theirs.length} of ${user.name}'s readers` : "their reader"}.
        {defaultServer && (
          <>
            {" "}Page-sync login on <strong>{defaultServer.name}</strong>:{" "}
            <code>{defaultServer.username || "—"}</code>{" "}
            <code>{defaultServer.password || "—"}</code>
          </>
        )} — the full list is under <strong>Settings → Page sync</strong>.
      </p>

      {theirs.length === 0 && (
        <p class="muted">
          Assign a reader to {user.name} first — open one under <strong>Unassigned readers</strong>
          {" "}
          and set its user. Until then there is nothing for a folder tick to reach.
        </p>
      )}

      <Shelf
        folders={libraries.value}
        binding={{
          state,
          toggle,
          label: theirs.length === 1
            ? `Sync to ${theirs[0].name || theirs[0].model || "their reader"}`
            : `Sync to ${user.name}'s readers`,
          disabledReason: theirs.length === 0 ? "no reader" : undefined,
        }}
      />

      {theirs.length > 0 && (
        <p class="muted small">
          Per-reader differences show as a half-ticked box. Open{" "}
          <button
            type="button"
            class="link"
            onClick={() => setScope({ kind: "device", id: theirs[0].id })}
          >
            {theirs[0].name || theirs[0].model || theirs[0].id}
          </button>{" "}
          to set folders for one reader alone.
        </p>
      )}
    </div>
  );
}
