// One reader: what it is carrying, and why.
//
// The page used to show the whole library with a checkbox on every folder
// header, and hide everything you might actually change behind a dialog called
// Edit whose only affirmative button was Close. Now the shelf is *this reader's*
// books, the two things that change often (who is holding it, which folders feed
// it) are on the header, and the rest is behind a disclosure — except a warning,
// which must never be.
import { useEffect, useState } from "preact/hooks";
import { api, errText, fmtBytes, fmtDate } from "./api.ts";
import { Check, Modal, Select, Tooltip } from "./components.tsx";
import { groupsFor } from "./grouping.ts";
import { Shelf } from "./Shelf.tsx";
import {
  books,
  devices,
  groupBy,
  libraries,
  loadBooks,
  loadDevices,
  loadLibraries,
  loadUsers,
  profiles,
  send,
  toast,
  users,
} from "./store.ts";
import type { Device, DeviceContents, Library, ReaderConfig, SyncOutcome } from "./types.ts";

export function DeviceView({ id }: { id: string }) {
  const d = devices.value.find((x) => x.id === id);

  useEffect(() => {
    loadUsers();
    loadLibraries();
  }, []);

  if (!d) return <p class="empty">This reader is no longer listed.</p>;

  const name = d.name || d.model || "this reader";
  // Folders with a rule keep their header even when empty — a rule you just
  // added must not look like it failed. Folders with no rule appear only if this
  // reader is actually carrying something out of them, which is what a book sent
  // by hand out of an unruled folder looks like.
  const present = new Set(books.value.map((b) => b.library_id));
  const folders = libraries.value.filter((l) => d.libraryIds.includes(l.id) || present.has(l.id));
  const groups = groupsFor(
    books.value,
    folders,
    groupBy.value,
    (folder) => d.libraryIds.includes(folder.id) ? "folder rule" : "sent by hand",
  );

  return (
    <div class="scope-view">
      <DeviceHeader device={d} />
      <PendingRemovals device={d} />

      <Shelf
        groups={groups}
        target={d.id}
        empty={
          <p class="empty">
            Nothing on {name} yet. Open <strong>Library</strong> and press{" "}
            <span class="send-mark">＋</span>{" "}
            on a book to send it — or add a folder rule above to keep a whole folder in step.
          </p>
        }
      />

      <Strays device={d} />
    </div>
  );
}

function DeviceHeader({ device: d }: { device: Device }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(d.name ?? "");
  const holder = users.value.find((u) => u.id === d.settings.user_id);
  const profile = profiles.value.find((p) => p.id === d.settings.profile_id);

  const patch = async (body: Record<string, unknown>) => {
    await api("PUT", `/api/devices/${d.id}/settings`, body);
    // Who holds a reader decides whose progress the shelf shows, so the books
    // have to catch up too.
    await Promise.all([loadDevices(), loadUsers()]);
    loadBooks();
  };

  // Everything about the connection in one hover, rather than a line of small
  // print that is only interesting when something is wrong.
  const detail: [string, string | null][] = [
    ["Address", d.state.host || d.last_ip || "unknown"],
    ["Last seen", fmtDate(d.last_seen)],
    ["Identified by", d.id_strategy === "ip" ? "network address" : d.id_strategy],
    ["On device", `${d.plan.onDevice} book(s)`],
    ["Sent by hand", d.plan.sent ? `${d.plan.sent} book(s)` : "none"],
    ["Waiting to send", d.plan.send ? `${d.plan.send} book(s)` : "nothing"],
    ["Last sync", d.state.lastSyncResult ?? null],
  ];

  return (
    <>
      <header class="scope-head">
        <span class={`dot${d.state.online ? " ok" : ""}`} />
        {renaming
          ? (
            <input
              value={name}
              autoFocus
              onInput={(e) => setName(e.currentTarget.value)}
              onBlur={async () => {
                setRenaming(false);
                if (name !== (d.name ?? "")) {
                  await api("PATCH", `/api/devices/${d.id}`, { name });
                  loadDevices();
                }
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          )
          : (
            <h2 onClick={() => setRenaming(true)} title="Click to rename">
              {d.name || d.model || d.id}
            </h2>
          )}
        <Tooltip rows={detail}>
          <span class={`badge ${d.state.online ? "online" : "offline"} has-detail`}>
            {d.state.syncing ? "syncing…" : d.state.online ? "online" : "offline"}
          </span>
        </Tooltip>
        {!d.settings.enabled && <span class="badge warn-badge">paused</span>}
        <span class="spacer" />
        {/* The one field that makes a reader useful. Never behind anything. */}
        <span class="muted small">Held by</span>
        <Select
          value={d.settings.user_id ?? ""}
          options={[
            ["", "— nobody —"],
            ...users.value.map((u): [string, string] => [u.id, u.name]),
          ]}
          onChange={(v) => patch({ user_id: v || null })}
        />
      </header>

      <div class="scope-facts">
        <span>{`On it: ${d.plan.onDevice} book${d.plan.onDevice === 1 ? "" : "s"}`}</span>
        <Rules device={d} />
        <span class="muted small">
          {`Resampling: ${profile ? profile.name : "none"}`}
        </span>
      </div>

      {/* A reader nobody holds cannot be given page-sync credentials at all. */}
      {!holder && (
        <p class="muted small">
          Nobody is holding this reader, so it is not set up for page sync — the only credentials it
          could be given would be somebody else's.
        </p>
      )}

      <Unsettled device={d} />
      <Advanced device={d} />
    </>
  );
}

/**
 * Folder rules: "everything in Comics, always".
 *
 * Sending one book is the primitive and a rule is the automation of it, so this
 * is a short statement with a way to change it rather than a checkbox on every
 * folder in the library. Removing a rule can clear a hundred books off a reader
 * that is not even awake, so past the threshold the server refuses and this
 * asks first.
 */
function Rules({ device: d }: { device: Device }) {
  const [editing, setEditing] = useState(false);
  const ruled = libraries.value.filter((l) => d.libraryIds.includes(l.id));

  const setRule = async (folder: Library, on: boolean, confirmed = false) => {
    const deviceIds = on
      ? [...new Set([...folder.deviceIds, d.id])]
      : folder.deviceIds.filter((x) => x !== d.id);
    try {
      await api(
        "PUT",
        `/api/libraries/${folder.id}${confirmed ? "?confirmRemovals=1" : ""}`,
        { deviceIds },
      );
      await Promise.all([loadLibraries(), loadDevices()]);
      loadBooks();
    } catch (err) {
      const message = errText(err);
      if (message === "confirm_removals") {
        if (
          confirm(
            `Dropping “${folder.name}” takes its books off ${d.name || d.id}. Go ahead?`,
          )
        ) await setRule(folder, on, true);
        return;
      }
      toast(message, "error");
    }
  };

  return (
    <>
      <span>
        {ruled.length
          ? (
            <>
              Always send: <strong>{ruled.map((l) => l.name).join(" · ")}</strong>
            </>
          )
          : <span class="muted">No folder rules</span>}
      </span>
      <button type="button" class="link" onClick={() => setEditing(true)}>
        {ruled.length ? "Change" : "Add a rule"}
      </button>

      {editing && (
        <Modal title="Folders that sync here" onClose={() => setEditing(false)}>
          <p class="muted">
            Everything in a ticked folder stays on this reader — new books arrive on their own, and
            a file you delete comes off. Books you send by hand are separate and are not affected.
          </p>
          {libraries.value.length === 0
            ? <p class="muted">No watched folders yet — add one from the sidebar.</p>
            : libraries.value.map((folder) => (
              <div key={folder.id} class="folder-row">
                <div>
                  <strong>{folder.name}</strong>
                  <div class="muted small">{`${folder.books} book(s)`}</div>
                </div>
                <span class="spacer" />
                <Check
                  label="Always send"
                  checked={folder.deviceIds.includes(d.id)}
                  onChange={(v) => setRule(folder, v)}
                />
              </div>
            ))}
          <div class="modal-actions">
            <span class="spacer" />
            <button type="button" class="primary" onClick={() => setEditing(false)}>Done</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * Page sync and the catalog are pushed automatically on every connect, so their
 * buttons are noise — until one of them has not taken, which is the only time
 * there is anything for a person to do.
 *
 * Deliberately outside the Advanced disclosure: a warning that hides inside a
 * collapsed accordion is not a warning.
 */
function Unsettled({ device: d }: { device: Device }) {
  const settled = (s: string | null) => s === "configured" || s === "unchanged" || s === "adopted";
  const pageBad = !!d.settings.user_id && !settled(d.settings.kosync_state);
  const catalogBad = !settled(d.settings.opds_state);
  if (!pageBad && !catalogBad) return null;

  return (
    <div class="banner">
      <div class="grow">
        {pageBad && (
          <div>
            <strong>Reading progress is not set up on this reader.</strong>{" "}
            <span class="small">{d.settings.kosync_detail ?? ""}</span>
          </div>
        )}
        {catalogBad && (
          <div>
            <strong>This reader cannot browse the library yet.</strong>{" "}
            <span class="small">{d.settings.opds_detail ?? ""}</span>
          </div>
        )}
      </div>
      <span class="spacer" />
      <button
        type="button"
        disabled={!d.state.online}
        onClick={async () => {
          try {
            if (pageBad) await api<ReaderConfig>("POST", `/api/devices/${d.id}/kosync`);
            if (catalogBad) await api<ReaderConfig>("POST", `/api/devices/${d.id}/opds`);
            loadDevices();
          } catch (err) {
            toast(errText(err), "error");
          }
        }}
      >
        {d.state.online ? "Try again" : "Reader is offline"}
      </button>
    </div>
  );
}

/**
 * The switches, the manual sync, the page-sync server override and Forget.
 *
 * All of these are either automatic or rare, which is exactly what a disclosure
 * is for — the old dialog gave them the same weight as the reader's name.
 */
function Advanced({ device: d }: { device: Device }) {
  const [syncing, setSyncing] = useState(false);
  const holder = users.value.find((u) => u.id === d.settings.user_id);

  const patch = async (body: Record<string, unknown>) => {
    await api("PUT", `/api/devices/${d.id}/settings`, body);
    loadDevices();
  };

  return (
    <details class="advanced">
      <summary>Advanced</summary>

      <div class="rule">
        <Check
          label="Sync to this reader"
          checked={!!d.settings.enabled}
          onChange={(v) => patch({ enabled: v ? 1 : 0 })}
        />
        <Check
          label="Automatically, when it wakes"
          checked={!!d.settings.auto_on_connect}
          onChange={(v) => patch({ auto_on_connect: v ? 1 : 0 })}
        />
      </div>

      <div class="rule">
        <Select
          value={d.settings.profile_id ?? ""}
          options={[
            ["", "Resampling: none (send as converted)"],
            ...profiles.value.map((p): [string, string] => [p.id, `Resampling: ${p.name}`]),
          ]}
          onChange={(v) => patch({ profile_id: v || null })}
        />
      </div>

      {/* Only worth a control once there is more than one place to report to. */}
      {holder && holder.syncServers.length > 1 && (
        <div class="rule">
          <Select
            value={d.settings.sync_server_id ?? ""}
            options={[
              ["", `Reports to ${holder.name}'s default`],
              ...holder.syncServers.map((s): [string, string] => [s.id, `Reports to ${s.name}`]),
            ]}
            onChange={(v) => patch({ sync_server_id: v || null })}
          />
        </div>
      )}

      {d.plan.sent > 0 && (
        <div class="folder-row">
          <div>
            <strong>{`Sent by hand · ${d.plan.sent}`}</strong>
            <div class="muted small">
              Books you sent to this reader directly. A folder rule covering one of them does not
              clear it — you said to send it, so it stays until you say otherwise.
            </div>
          </div>
          <span class="spacer" />
          <button
            type="button"
            onClick={async () => {
              if (!confirm(`Take all ${d.plan.sent} hand-sent books off ${d.name || d.id}?`)) {
                return;
              }
              await send(d.id, d.pinnedBookIds, false);
            }}
          >
            Clear them
          </button>
        </div>
      )}

      <div class="folder-row">
        <div>
          <strong>Sync now</strong>
          <div class="muted small">
            Books sync by themselves whenever the reader is awake. Only needed if you have turned
            that off above.
          </div>
        </div>
        <span class="spacer" />
        <button
          type="button"
          disabled={syncing || d.state.syncing || !d.state.online}
          onClick={async () => {
            setSyncing(true);
            try {
              const r = await api<SyncOutcome>("POST", `/api/devices/${d.id}/sync`);
              toast(`${d.name || d.id}: ${r.message}`, r.failed ? "error" : "ok");
            } catch (err) {
              toast(errText(err), "error");
            }
            setSyncing(false);
            loadDevices();
            loadBooks();
          }}
        >
          {d.state.syncing ? "Syncing…" : d.state.online ? "Sync now" : "Offline"}
        </button>
      </div>

      <div class="folder-row">
        <div>
          <strong>Forget this reader</strong>
          <div class="muted small">
            Drops it and its sync history. Books on the reader are left alone.
          </div>
        </div>
        <span class="spacer" />
        <button
          type="button"
          class="danger"
          onClick={async () => {
            if (!confirm("Forget this reader and its sync history?")) return;
            await api("DELETE", `/api/devices/${d.id}`);
            loadDevices();
          }}
        >
          Forget
        </button>
      </div>
    </details>
  );
}

/**
 * The one thing an automatic sync will not do by itself. Past the threshold it
 * stops and changes nothing, so without this the removals would wait forever —
 * see REMOVAL_CONFIRM_THRESHOLD in src/sync/engine.ts.
 */
function PendingRemovals({ device: d }: { device: Device }) {
  const [busy, setBusy] = useState(false);
  if (!d.plan.needsConfirm) return null;

  return (
    <div class="banner">
      <strong>{`${d.plan.remove} books are no longer meant to be on this reader.`}</strong>
      <span>Syncing has paused rather than delete that many on its own.</span>
      <span class="spacer" />
      <button
        type="button"
        disabled={busy || !d.state.online}
        onClick={async () => {
          setBusy(true);
          try {
            // Ask first without confirming: that run changes nothing and comes
            // back with the actual titles, so the warning names what it deletes.
            const dry = await api<SyncOutcome>("POST", `/api/devices/${d.id}/sync`);
            const list = dry.pendingRemovals ?? [];
            const titles = list.slice(0, 8).map((b) => `• ${b.title}`).join("\n");
            const more = list.length > 8 ? `\n…and ${list.length - 8} more` : "";
            if (list.length && confirm(`Remove from ${d.name || d.id}:\n\n${titles}${more}`)) {
              const r = await api<SyncOutcome>(
                "POST",
                `/api/devices/${d.id}/sync?confirmRemovals=1`,
              );
              toast(r.message, r.failed ? "error" : "ok");
            }
          } catch (err) {
            toast(errText(err), "error");
          }
          setBusy(false);
          loadDevices();
          loadBooks();
        }}
      >
        {d.state.online ? "Remove them" : "Reader is offline"}
      </button>
    </div>
  );
}

/**
 * Files on the reader that are not books of ours at all — side-loaded EPUBs.
 *
 * Books we sent whose file has since left the library now appear in the shelf
 * above, in their own group, so this section is finally only what its heading
 * says. A sync never touches these, which is the whole reason to show them.
 */
function Strays({ device: d }: { device: Device }) {
  const [data, setData] = useState<DeviceContents | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One round trip to the reader per visit; it is the only way to know what is
  // actually there, and the manifest alone would miss side-loaded files.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api<DeviceContents>("GET", `/api/devices/${d.id}/contents`)
      .then((r) => !cancelled && setData(r))
      .catch((err) => !cancelled && setError(errText(err)));
    return () => {
      cancelled = true;
    };
  }, [d.id, d.contentCount]);

  if (error) return null;
  if (!data) return <p class="muted small">Checking what else is on the reader…</p>;

  const strays = data.files.filter((f) => !f.title);
  if (!strays.length) return null;

  return (
    <section class="folder-group strays">
      <header class="folder-head">
        <span class="caret">Also on {d.name || d.model || "this reader"}</span>
        <span class="muted small">{strays.length}</span>
        <span class="spacer" />
        <span class="muted small">Not from your library — sync leaves these alone</span>
      </header>
      <ul class="stray-list">
        {strays.map((f) => (
          <li key={f.path}>
            <span class="name">{f.path.replace(/^\//, "")}</span>
            <span class="spacer" />
            <span class="muted small">{fmtBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      {data.error && <p class="muted small">{data.error}</p>}
    </section>
  );
}
