// Naming the people the library is for.
//
// Moved out of Settings: a person is not a preference, they are one of the three
// things the rail lays out. Each keeps their own reading positions and page-sync
// credentials, which is why two people reading the same file stay independent.
import { useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import { Modal } from "./components.tsx";
import { loadStatus, loadUsers, setScope, toast, users } from "./store.ts";

export function AddPerson({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const created = await api<{ id: string }>("POST", "/api/users", { name: trimmed });
      await Promise.all([loadUsers(), loadStatus()]);
      setScope({ kind: "user", id: created.id });
      onClose();
    } catch (err) {
      toast(errText(err), "error");
    }
    setBusy(false);
  };

  return (
    <Modal title="Add a person" onClose={onClose}>
      <p class="muted">
        Each person keeps their own reading positions and page-sync login. Say who is holding a
        reader on that reader's page — change it whenever somebody else picks it up.
      </p>
      <div class="toolbar">
        <input
          placeholder="Name"
          value={name}
          autoFocus
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <span class="spacer" />
        <button type="button" class="primary" disabled={busy || !name.trim()} onClick={add}>
          Add
        </button>
      </div>

      {users.value.length > 0 && (
        <div class="folders">
          {users.value.map((u) => (
            <div key={u.id} class="folder-row">
              <div>
                <strong>{u.name}</strong>
                <div class="muted small">
                  {u.deviceIds.length ? `${u.deviceIds.length} reader(s)` : "no reader assigned"}
                </div>
              </div>
              <span class="spacer" />
              <button
                type="button"
                class="danger"
                onClick={async () => {
                  if (
                    !confirm(
                      `Remove “${u.name}”? Their reading positions and sync credentials are ` +
                        `deleted. Books and folders are untouched.`,
                    )
                  ) return;
                  await api("DELETE", `/api/users/${u.id}`);
                  await Promise.all([loadUsers(), loadStatus()]);
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
