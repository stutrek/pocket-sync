// A reader the app has just met.
//
// Making a reader useful used to mean finding it under "Unassigned readers",
// opening a dialog called Edit, and setting a dropdown called "Held by" — with
// nothing anywhere saying that was the step. This is that step, offered once,
// at the moment the reader turns up.
//
// A card rather than a modal: this is raised by a discovery event, and a modal
// that appears because something happened on the network is an ambush.
import { useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import { Select } from "./components.tsx";
import {
  devices,
  loadBooks,
  loadDevices,
  loadUsers,
  setScope,
  setTarget,
  toast,
  users,
} from "./store.ts";
import type { Device } from "./types.ts";

export function NewReaders() {
  const fresh = devices.value.filter((d) => !d.settings.setup_at);
  if (!fresh.length) return null;
  return (
    <>
      {fresh.map((d) => <NewReader key={d.id} device={d} />)}
    </>
  );
}

function NewReader({ device: d }: { device: Device }) {
  const [name, setName] = useState(d.name || d.model || "");
  // One person is the common case, and making them re-state it is noise.
  const [holder, setHolder] = useState(users.value.length === 1 ? users.value[0].id : "");
  const [busy, setBusy] = useState(false);

  const dismiss = async () => {
    await api("PUT", `/api/devices/${d.id}/settings`, { setup_at: new Date().toISOString() });
    loadDevices();
  };

  return (
    <div class="banner new-reader">
      <div class="grow">
        <strong>{`New reader found: ${d.model || d.id}`}</strong>
        <div class="muted small">
          Resampling, page sync and the catalog are set up for you. Say who is holding it so its
          reading progress lands on the right shelf.
        </div>
        <div class="rule">
          <input
            value={name}
            placeholder="Name this reader"
            onInput={(e) => setName(e.currentTarget.value)}
          />
          {users.value.length > 0
            ? (
              <Select
                value={holder}
                options={[
                  ["", "— who is holding it? —"],
                  ...users.value.map((u): [string, string] => [u.id, u.name]),
                ]}
                onChange={setHolder}
              />
            )
            : <span class="muted small">Add a person first — you can set this later.</span>}
        </div>
      </div>
      <span class="spacer" />
      <button
        type="button"
        class="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            if (name && name !== d.name) await api("PATCH", `/api/devices/${d.id}`, { name });
            await api("PUT", `/api/devices/${d.id}/settings`, {
              user_id: holder || null,
              setup_at: new Date().toISOString(),
            });
            await Promise.all([loadDevices(), loadUsers()]);
            // Land on the reader, with it already chosen as where a send goes —
            // its shelf is empty, and every cover in the library now has a
            // button pointing at it.
            setTarget(d.id);
            setScope({ kind: "device", id: d.id });
            loadBooks();
          } catch (err) {
            toast(errText(err), "error");
          }
          setBusy(false);
        }}
      >
        Set up
      </button>
      <button type="button" onClick={dismiss}>Not now</button>
    </div>
  );
}
