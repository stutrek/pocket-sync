// One reader: what it holds and the folders that feed it. Syncing is automatic,
// so there is no button for it — the page is about what the reader carries, and
// everything you might change about the reader itself is behind Edit.
import { useEffect, useState } from "preact/hooks";
import { api, errText, fmtBytes, fmtDate } from "./api.ts";
import { Check, Modal, Select, Tooltip } from "./components.tsx";
import { Shelf } from "./Shelf.tsx";
import type { Bound } from "./Shelf.tsx";
import {
  devices,
  libraries,
  loadBooks,
  loadDevices,
  loadLibraries,
  loadUsers,
  profiles,
  toast,
  users,
} from "./store.ts";
import type { Device, DeviceContents, Library, ReaderConfig, SyncOutcome } from "./types.ts";

export function DeviceView({ id }: { id: string }) {
  const d = devices.value.find((x) => x.id === id);

  useEffect(() => {
    loadUsers();
  }, []);

  if (!d) return <p class="empty">This reader is no longer listed.</p>;

  const state = (folder: Library): Bound => folder.deviceIds.includes(d.id) ? "on" : "off";

  /** Folders are many-to-many, so toggling one leaves the others alone. */
  const toggle = async (folder: Library, on: boolean) => {
    const deviceIds = on
      ? [...new Set([...folder.deviceIds, d.id])]
      : folder.deviceIds.filter((x) => x !== d.id);
    try {
      await api("PUT", `/api/libraries/${folder.id}`, { deviceIds });
      await Promise.all([loadLibraries(), loadDevices()]);
    } catch (err) {
      toast(errText(err), "error");
    }
  };

  const name = d.name || d.model || "this reader";

  return (
    <div class="scope-view">
      <DeviceHeader device={d} />
      <PendingRemovals device={d} />

      <Shelf
        folders={libraries.value}
        binding={{ state, toggle, label: `Sync to ${name}` }}
      />

      <Strays device={d} />
    </div>
  );
}

function DeviceHeader({ device: d }: { device: Device }) {
  const [editing, setEditing] = useState(false);

  const holder = users.value.find((u) => u.id === d.settings.user_id);

  // Everything about the connection in one hover, rather than a line of small
  // print under the name that is only interesting when something is wrong.
  const detail: [string, string | null][] = [
    ["Address", d.state.host || d.last_ip || "unknown"],
    ["Last seen", fmtDate(d.last_seen)],
    ["Identified by", d.id_strategy === "ip" ? "network address" : d.id_strategy],
    ["On device", `${d.plan.onDevice} book(s)`],
    ["Waiting to send", d.plan.send ? `${d.plan.send} book(s)` : "nothing"],
    ["To remove", d.plan.remove ? `${d.plan.remove} book(s)` : null],
    ["Last sync", d.state.lastSyncResult ?? null],
  ];

  return (
    <>
      <header class="scope-head">
        <span class={`dot${d.state.online ? " ok" : ""}`} />
        <h2>{d.name || d.model || d.id}</h2>
        <Tooltip rows={detail}>
          <span class={`badge ${d.state.online ? "online" : "offline"} has-detail`}>
            {d.state.syncing ? "syncing…" : d.state.online ? "online" : "offline"}
          </span>
        </Tooltip>
        {d.model && <span class="badge">{d.model}</span>}
        {/* Edit hides the switch, so the state has to show here. */}
        {!d.settings.enabled && <span class="badge warn-badge">paused</span>}
        {holder && <span class="muted small">{holder.name}</span>}
        <span class="spacer" />
        <button type="button" onClick={() => setEditing(true)}>Edit</button>
      </header>

      {editing && <EditDialog device={d} onClose={() => setEditing(false)} />}
    </>
  );
}

/**
 * Everything about the reader itself. Settings save on change — there is no
 * Save button to forget to press — so closing the dialog cannot lose an edit.
 */
function EditDialog({ device: d, onClose }: { device: Device; onClose: () => void }) {
  const [name, setName] = useState(d.name ?? "");
  const [syncing, setSyncing] = useState(false);

  const patchSettings = async (patch: Record<string, unknown>) => {
    await api("PUT", `/api/devices/${d.id}/settings`, patch);
    // Who holds a reader decides where it sits in the rail and whose progress
    // the shelf shows, so both lists have to catch up before the next paint.
    await Promise.all([loadDevices(), loadUsers()]);
    loadBooks();
  };

  return (
    <Modal title={d.name || d.model || d.id} onClose={onClose}>
      <div class="form">
        <label>Name</label>
        <div class="rule">
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <button
            type="button"
            disabled={name === (d.name ?? "")}
            onClick={async () => {
              await api("PATCH", `/api/devices/${d.id}`, { name });
              loadDevices();
              toast("Renamed", "ok");
            }}
          >
            Save
          </button>
        </div>

        <label>Held by</label>
        <Select
          value={d.settings.user_id ?? ""}
          options={[
            ["", "— nobody —"],
            ...users.value.map((u): [string, string] => [u.id, u.name]),
          ]}
          onChange={(v) => patchSettings({ user_id: v || null })}
        />

        <label>Resampling</label>
        <Select
          value={d.settings.profile_id ?? ""}
          options={[
            ["", "None (send as converted)"],
            ...profiles.value.map((p): [string, string] => [p.id, p.name]),
          ]}
          onChange={(v) => patchSettings({ profile_id: v || null })}
        />

        <label>Syncing</label>
        <div class="checks">
          <Check
            label="Sync to this reader"
            checked={!!d.settings.enabled}
            onChange={(v) => patchSettings({ enabled: v ? 1 : 0 })}
          />
          <Check
            label="Automatically, when it wakes"
            checked={!!d.settings.auto_on_connect}
            onChange={(v) => patchSettings({ auto_on_connect: v ? 1 : 0 })}
          />
        </div>

        <label>Reports to</label>
        <PageSync
          device={d}
          onChange={(sync_server_id) => patchSettings({ sync_server_id })}
        />

        <label>Browses</label>
        <Catalog device={d} />
      </div>

      {/* In the footer these read as the dialog's OK and Cancel. Forget is not. */}
      <div class="modal-row">
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

      <div class="modal-row">
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
            onClose();
          }}
        >
          Forget
        </button>
      </div>

      <div class="modal-actions">
        <span class="spacer" />
        <button type="button" class="primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/**
 * Where this reader reports reading progress, and whether it has been told.
 *
 * Setting this up is otherwise a URL, a username and a password typed on an
 * e-ink keyboard, so we write it to the reader on every sync. The picker is
 * an override: normally a reader follows its holder's default, which is what
 * makes handing it to somebody else move it to *their* server. Pinning it here
 * is for the reader that should stay where it is — usually one we adopted
 * because it was already pointed somewhere when we first saw it.
 */
function PageSync(
  { device: d, onChange }: { device: Device; onChange: (serverId: string | null) => Promise<void> },
) {
  const [busy, setBusy] = useState(false);
  const { kosync_state: state, kosync_detail: detail } = d.settings;
  const holder = users.value.find((u) => u.id === d.settings.user_id);

  if (!holder) {
    return (
      <div class="small warn">
        Nobody is holding this reader, so it is not set up for page sync — the only credentials it
        could be given would be somebody else's.
      </div>
    );
  }

  const push = async () => {
    setBusy(true);
    try {
      const r = await api<ReaderConfig>("POST", `/api/devices/${d.id}/kosync`);
      toast(r.detail || r.state, r.state === "failed" ? "error" : "ok");
      loadDevices();
    } catch (err) {
      toast(errText(err), "error");
    }
    setBusy(false);
  };

  const settled = state === "configured" || state === "unchanged" || state === "adopted";
  // With one server there is nothing to choose: "follow the default" and the
  // single server are the same destination, and offering both reads as a
  // duplicate rather than as an override. The picker earns its place only once
  // a second server exists.
  const choices = holder.syncServers.length > 1;

  return (
    <div>
      {choices && (
        <Select
          value={d.settings.sync_server_id ?? ""}
          options={[
            ["", `Follow ${holder.name}'s default`],
            ...holder.syncServers.map((s): [string, string] => [
              s.id,
              s.id === holder.defaultSyncServerId ? `${s.name} (their default)` : s.name,
            ]),
          ]}
          onChange={(v) => onChange(v || null)}
        />
      )}
      <div class={settled ? "muted small" : "small warn"}>
        {detail || "Not set up on this reader yet."}
        {d.settings.kosync_at && settled && ` · ${fmtDate(d.settings.kosync_at)}`}
      </div>
      <button type="button" disabled={busy || !d.state.online} onClick={push}>
        {!d.state.online
          ? "Reader is offline"
          : state === "adopted"
          ? "Point it at the chosen server"
          : settled
          ? "Set up again"
          : "Set up on the reader"}
      </button>
    </div>
  );
}

/**
 * Whether this reader can browse the library itself.
 *
 * Shown even when the catalog is switched off, because "off in Settings" is the
 * commonest reason nothing happened and it is otherwise indistinguishable from
 * the feature not existing. Unlike page sync this needs no holder: the catalog
 * is scoped by bound folder and resample profile, neither of which is personal.
 */
function Catalog({ device: d }: { device: Device }) {
  const [busy, setBusy] = useState(false);
  const { opds_state: state, opds_detail: detail } = d.settings;
  const settled = state === "configured" || state === "unchanged";

  const push = async () => {
    setBusy(true);
    try {
      const r = await api<ReaderConfig>("POST", `/api/devices/${d.id}/opds`);
      toast(r.detail || r.state, r.state === "failed" ? "error" : "ok");
      loadDevices();
    } catch (err) {
      toast(errText(err), "error");
    }
    setBusy(false);
  };

  return (
    <div>
      <div class={settled ? "muted small" : "small warn"}>
        {detail || "Not added to this reader yet."}
        {d.settings.opds_at && settled && ` · ${fmtDate(d.settings.opds_at)}`}
      </div>
      <button type="button" disabled={busy || !d.state.online} onClick={push}>
        {!d.state.online ? "Reader is offline" : settled ? "Add again" : "Add to the reader"}
      </button>
    </div>
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
      <strong>{`${d.plan.remove} books are no longer in these folders.`}</strong>
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
 * Books on the reader that no folder accounts for: side-loaded files, and books
 * whose file has left the folder. Everything the folders above *do* account for
 * is already shown as covers, so listing it again in a table said nothing.
 *
 * These are never touched by a sync — only files Pocket Sync put there are ever
 * removed — so the point of the section is that they are visible at all.
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
        <span class="muted small">Not in your library — sync leaves these alone</span>
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
