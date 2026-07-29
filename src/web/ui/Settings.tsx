import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import { Check, Field } from "./components.tsx";
import { Discovery } from "./Discovery.tsx";
import {
  loadDevices,
  loadProfiles,
  loadSettings,
  loadStatus,
  loadUsers,
  profiles,
  settings,
  toast,
  users,
} from "./store.ts";
import type {
  CalibreKeys,
  LogLevel,
  OpdsStatus,
  Profile,
  Settings as Config,
  User,
} from "./types.ts";

/**
 * Each row carries its own accessors instead of a string path, so a renamed or
 * retyped field in src/core/config.ts fails `deno task check` here.
 */
type Row =
  | { kind: "heading"; label: string }
  | { kind: "text"; label: string; get: (c: Config) => string; set: (c: Config, v: string) => void }
  | {
    kind: "number";
    label: string;
    get: (c: Config) => number;
    set: (c: Config, v: number) => void;
  }
  | {
    kind: "check";
    label: string;
    get: (c: Config) => boolean;
    set: (c: Config, v: boolean) => void;
  }
  | {
    kind: "select";
    label: string;
    options: readonly LogLevel[];
    get: (c: Config) => LogLevel;
    set: (c: Config, v: LogLevel) => void;
  };

/**
 * The handful of settings that are actually decisions somebody makes.
 *
 * Everything else moved to ADVANCED_ROWS below. The split is not cosmetic: this
 * tab used to put "Folders to sync" — the single most important control in the
 * app — in the same list as the socket timeout, which is how a settings page
 * stops being read at all.
 */
const BASIC_ROWS: Row[] = [
  { kind: "heading", label: "This app" },
  {
    kind: "check",
    label: "Sync to readers automatically",
    get: (c) => c.autoSyncEnabled,
    set: (c, v) => (c.autoSyncEnabled = v),
  },
  {
    kind: "check",
    label: "Start Pocket Sync at login",
    get: (c) => c.startAtLogin,
    set: (c, v) => (c.startAtLogin = v),
  },
  {
    kind: "text",
    label: "Folder on the reader",
    get: (c) => c.upload.path,
    set: (c, v) => (c.upload.path = v),
  },

  { kind: "heading", label: "Reading progress (KOReader sync)" },
  {
    kind: "check",
    label: "Run Pocket Sync's own sync server",
    get: (c) => c.kosync.enabled,
    set: (c, v) => (c.kosync.enabled = v),
  },

  { kind: "heading", label: "Library catalog (OPDS)" },
  {
    kind: "check",
    label: "Let readers browse and download the library",
    get: (c) => c.opds.enabled,
    set: (c, v) => (c.opds.enabled = v),
  },

  { kind: "heading", label: "Discovery" },
  {
    kind: "check",
    label: "Look for readers by UDP broadcast",
    get: (c) => c.discovery.enabled,
    set: (c, v) => (c.discovery.enabled = v),
  },
  {
    kind: "text",
    label: "Readers at fixed addresses (comma separated)",
    get: (c) => c.discovery.manualHosts.join(", "),
    set: (c, v) => (c.discovery.manualHosts = v.split(",").map((s) => s.trim()).filter(Boolean)),
  },
];

/**
 * Tuning, diagnostics and paths that are probed automatically.
 *
 * Kept working rather than deleted — they are the levers for a reader that
 * misbehaves on a particular network, and `config.json` is hand-editable
 * anyway, so hiding them and removing them are different things.
 */
const ADVANCED_ROWS: Row[] = [
  { kind: "heading", label: "Paths" },
  {
    kind: "text",
    label: "ebook-convert path",
    get: (c) => c.calibrePath,
    set: (c, v) => (c.calibrePath = v),
  },
  {
    kind: "text",
    label: "ebook-meta path",
    get: (c) => c.ebookMetaPath,
    set: (c, v) => (c.ebookMetaPath = v),
  },
  {
    kind: "text",
    label: "Python for the engine",
    get: (c) => c.pythonPath,
    set: (c, v) => (c.pythonPath = v),
  },

  { kind: "heading", label: "Web UI" },
  {
    kind: "number",
    label: "Browser port (restart to apply)",
    get: (c) => c.webPort,
    set: (c, v) => (c.webPort = v),
  },
  { kind: "text", label: "Bind address", get: (c) => c.webHost, set: (c, v) => (c.webHost = v) },

  { kind: "heading", label: "Discovery" },
  {
    kind: "number",
    label: "Scan interval (s)",
    get: (c) => c.discovery.intervalSec,
    set: (c, v) => (c.discovery.intervalSec = v),
  },
  {
    kind: "number",
    label: "Scan timeout (s)",
    get: (c) => c.discovery.timeoutSec,
    set: (c, v) => (c.discovery.timeoutSec = v),
  },
  {
    kind: "number",
    label: "Connect debounce (s)",
    get: (c) => c.discovery.debounceSec,
    set: (c, v) => (c.discovery.debounceSec = v),
  },
  {
    kind: "check",
    label: "Try hotspot 192.168.4.1",
    get: (c) => c.discovery.hotspotFallback,
    set: (c, v) => (c.discovery.hotspotFallback = v),
  },

  { kind: "heading", label: "Transfer" },
  {
    kind: "number",
    label: "Chunk size (max 2048)",
    get: (c) => c.upload.chunkSize,
    set: (c, v) => (c.upload.chunkSize = v),
  },
  {
    kind: "number",
    label: "Upload retries",
    get: (c) => c.upload.retries,
    set: (c, v) => (c.upload.retries = v),
  },
  {
    kind: "number",
    label: "Retry delay (s)",
    get: (c) => c.upload.retryDelaySec,
    set: (c, v) => (c.upload.retryDelaySec = v),
  },
  {
    kind: "number",
    label: "Cooldown between books (s)",
    get: (c) => c.upload.bookCooldownSec,
    set: (c, v) => (c.upload.bookCooldownSec = v),
  },
  {
    kind: "number",
    label: "Socket timeout (s)",
    get: (c) => c.upload.socketTimeoutSec,
    set: (c, v) => (c.upload.socketTimeoutSec = v),
  },
  {
    kind: "check",
    label: "WebDAV fallback if uploads fail",
    get: (c) => c.upload.webdavFallback,
    set: (c, v) => (c.upload.webdavFallback = v),
  },

  { kind: "heading", label: "Ports" },
  {
    kind: "number",
    label: "Sync server port",
    get: (c) => c.kosync.port,
    set: (c, v) => (c.kosync.port = v),
  },
  {
    kind: "number",
    label: "Catalog port",
    get: (c) => c.opds.port,
    set: (c, v) => (c.opds.port = v),
  },

  { kind: "heading", label: "Watched folders" },
  {
    kind: "number",
    label: "Rescan interval (s)",
    get: (c) => c.scan.intervalSec,
    set: (c, v) => (c.scan.intervalSec = v),
  },
  {
    kind: "number",
    label: "Settle before importing (s)",
    get: (c) => c.scan.settleSec,
    set: (c, v) => (c.scan.settleSec = v),
  },

  { kind: "heading", label: "Diagnostics" },
  {
    kind: "select",
    label: "Log level",
    options: ["debug", "info", "warn", "error"],
    get: (c) => c.logLevel,
    set: (c, v) => (c.logLevel = v),
  },
];

type Edit = <T>(set: (c: Config, v: T) => void, value: T) => void;

function control(row: Exclude<Row, { kind: "heading" }>, draft: Config, edit: Edit) {
  switch (row.kind) {
    case "check":
      return (
        <input
          type="checkbox"
          checked={row.get(draft)}
          onChange={(e) => edit(row.set, e.currentTarget.checked)}
        />
      );
    case "select":
      return (
        <select
          value={row.get(draft)}
          onChange={(e) => edit(row.set, e.currentTarget.value as LogLevel)}
        >
          {row.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "number":
      return (
        <input
          type="number"
          value={String(row.get(draft))}
          onInput={(e) => edit(row.set, Number(e.currentTarget.value))}
        />
      );
    case "text":
      return (
        <input
          type="text"
          value={row.get(draft)}
          onInput={(e) => edit(row.set, e.currentTarget.value)}
        />
      );
  }
}

export function SettingsView() {
  const [draft, setDraft] = useState<Config | null>(null);
  const [note, setNote] = useState("");
  const loaded = settings.value;

  useEffect(() => {
    if (!loaded) loadSettings();
    else setDraft(structuredClone(loaded));
  }, [loaded]);

  const edit = <T,>(set: (c: Config, v: T) => void, value: T) =>
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      set(next, value);
      return next;
    });

  // `.form` is a two-column grid and needs label and control to be DOM
  // siblings, so the advanced block gets its own grid rather than wrapping rows
  // of this one.
  const rows = (list: Row[]) =>
    draft && list.map((row, i) => {
      if (row.kind === "heading") return <h3 key={i}>{row.label}</h3>;
      return (
        <Fragment key={i}>
          <label>{row.label}</label>
          {control(row, draft, edit)}
        </Fragment>
      );
    });

  return (
    <section class="view">
      <div class="split">
        <div class="pane grow">
          <h2>Settings</h2>
          <p class="muted">
            Books, folders and people live in the <strong>Library</strong>{" "}
            — this is how this machine talks to readers.
          </p>
          <form class="form" onSubmit={(e) => e.preventDefault()}>
            {rows(BASIC_ROWS)}
          </form>

          <details class="advanced">
            <summary>Advanced</summary>
            <form class="form" onSubmit={(e) => e.preventDefault()}>
              {rows(ADVANCED_ROWS)}
            </form>
          </details>

          <button
            type="button"
            class="primary"
            disabled={!draft}
            onClick={async () => {
              if (!draft) return;
              settings.value = await api<Config>("PUT", "/api/settings", draft);
              toast("Settings saved", "ok");
              // The sync server rebinds live; only the browser UI's own
              // listener is fixed at startup.
              setNote("Browser port and bind address take effect after restarting the app.");
              loadStatus();
              loadUsers();
            }}
          >
            Save settings
          </button>
          <p class="muted">{note}</p>
        </div>

        <div class="pane grow">
          <Discovery />

          <ReaderKeys />

          <KosyncCard />

          <CatalogCard />

          <h2>Resampling profiles</h2>
          <div>
            {profiles.value.map((p) => <ProfileEditor key={p.id} profile={p} />)}
          </div>
          <button
            type="button"
            onClick={async () => {
              const name = prompt("Profile name", "New profile");
              if (!name) return;
              await api("POST", "/api/profiles", { name });
              loadProfiles();
            }}
          >
            New profile
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Page sync: each person's list of sync servers, and which one their readers
 * follow.
 *
 * Ours is always the first entry and needs no setup — we resolve this machine's
 * LAN address, generate the credentials and write all three into the reader on
 * its next sync. The rest of the list is servers the user added, or ones we
 * adopted off a reader that was already pointed somewhere when we found it.
 */
function KosyncCard() {
  useEffect(() => {
    loadUsers();
  }, [settings.value]);

  const cfg = settings.value;
  if (!cfg) return null;

  return (
    <div class="folders">
      <h2>Page sync</h2>
      <p class="muted">
        Each reader is pointed at its holder's default server the next time it syncs — say who is
        holding it on the reader's page. Progress arrives when you tap <em>Sync Progress</em>{" "}
        on the reader; it is not continuous.
      </p>
      {!cfg.kosync.enabled && (
        <p class="warn">
          Pocket Sync's own sync server is turned off above, so it cannot be anybody's default.
          Readers pointed at somebody else's server keep working.
        </p>
      )}
      {users.value.length === 0
        ? <p class="muted">Add a person above and their sync servers will appear here.</p>
        : users.value.map((u) => <UserServers key={u.id} user={u} />)}
    </div>
  );
}

/**
 * The OPDS catalog: whether readers can come and fetch books for themselves.
 *
 * This card exists mostly to make the trade explicit before it is switched on.
 * Everything else in Settings is a preference; this one publishes the books, so
 * the consequence is stated next to the switch rather than in the README.
 *
 * The per-reader addresses are shown because they are the fallback: CrossPoint
 * firmware has an OPDS browser and gets its entry pushed automatically, but any
 * other client — KOReader on a phone, Calibre — needs the address typed in.
 */
function CatalogCard() {
  const [info, setInfo] = useState<OpdsStatus | null>(null);
  const cfg = settings.value;

  useEffect(() => {
    api<OpdsStatus>("GET", "/api/opds").then(setInfo).catch(() => setInfo(null));
  }, [settings.value]);

  if (!cfg) return null;

  return (
    <div class="folders">
      <h2>Library catalog</h2>
      <p class="muted">
        Readers can browse the library and pull books themselves, instead of waiting to be sent
        them. A book fetched by a reader is resampled for that reader, and its reading position
        still comes back. Turn it on above.
      </p>

      {!cfg.opds.enabled
        ? (
          <p class="muted">
            The catalog is off. While it is on, anything that can reach port {cfg.opds.port}{" "}
            on your network can download your books — there is no password. Nothing there can write
            or delete, and it only ever shows the folders you already watch.
          </p>
        )
        : (
          <>
            <p class="warn">
              The catalog is on. Anything that can reach port {cfg.opds.port}{" "}
              on your network can download your books — there is no password.
            </p>
            {info?.url
              ? (
                <div class="folder-row">
                  <div>
                    <strong>Catalog address</strong>
                    <div class="muted small">
                      For a phone or Calibre. Readers get their own address added for them — each
                      one is listed on its device page.
                    </div>
                  </div>
                  <span class="spacer" />
                  <code>{info.url}</code>
                </div>
              )
              : <p class="warn">{info?.reason ?? "Working out this machine's address…"}</p>}
          </>
        )}
    </div>
  );
}

/**
 * One person's servers.
 *
 * The default is a radio-style choice rather than a dropdown because it is the
 * whole point of the list — every reader they pick up follows it — and because
 * seeing the credentials next to it is what makes setting a reader up by hand
 * possible when the automatic push does not take.
 */
function UserServers({ user: u }: { user: User }) {
  const [adding, setAdding] = useState(false);

  const setDefault = async (serverId: string) => {
    try {
      await api("PUT", `/api/users/${u.id}`, { defaultSyncServerId: serverId });
      await Promise.all([loadUsers(), loadDevices()]);
      toast(`${u.name}'s readers now report to this server`, "ok");
    } catch (err) {
      toast(errText(err), "error");
    }
  };

  return (
    <div class="server-group">
      <h3>{u.name}</h3>
      {u.syncServers.map((s) => (
        <div key={s.id} class="folder-row">
          <div>
            <strong>{s.name}</strong>
            {s.id === u.defaultSyncServerId && <span class="badge">default</span>}
            {s.adopted && <span class="badge">from a reader</span>}
            <div class="muted small">
              {s.url || "no address yet"}
              {s.username ? ` · ${s.username} / ${s.password}` : " · no username set"}
            </div>
            {!s.available && <div class="small warn">{s.reason}</div>}
          </div>
          <span class="spacer" />
          {s.id === u.defaultSyncServerId
            ? <span class="muted small">in use</span>
            : (
              <button type="button" disabled={!s.available} onClick={() => setDefault(s.id)}>
                Use this one
              </button>
            )}
          {
            /* Ours is shared by everyone and switched off in Settings, not
              deleted from one person's list. */
          }
          {!s.builtin && (
            <button
              type="button"
              class="danger"
              onClick={async () => {
                if (
                  !confirm(
                    `Remove “${s.name}” from ${u.name}'s sync servers? Readers using it fall ` +
                      `back to their default. The server itself is not touched.`,
                  )
                ) return;
                try {
                  await api("DELETE", `/api/users/${u.id}/servers/${s.id}`);
                  await Promise.all([loadUsers(), loadDevices()]);
                } catch (err) {
                  toast(errText(err), "error");
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      ))}

      {adding
        ? <AddServer user={u} onDone={() => setAdding(false)} />
        : (
          <button type="button" onClick={() => setAdding(true)}>
            Add a sync server…
          </button>
        )}
    </div>
  );
}

/** A KOReader-compatible server elsewhere — self-hosted, or somebody else's. */
function AddServer({ user: u, onDone }: { user: User; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div class="form">
      <label>Address</label>
      <input
        placeholder="https://sync.example.org"
        spellcheck={false}
        value={form.url}
        onInput={(e) => set("url", e.currentTarget.value)}
      />
      <label>Name</label>
      <input
        placeholder="optional — the address is used otherwise"
        value={form.name}
        onInput={(e) => set("name", e.currentTarget.value)}
      />
      <label>Username</label>
      <input
        spellcheck={false}
        value={form.username}
        onInput={(e) => set("username", e.currentTarget.value)}
      />
      <label>Password</label>
      <input
        spellcheck={false}
        value={form.password}
        onInput={(e) => set("password", e.currentTarget.value)}
      />
      <span />
      <div class="toolbar">
        <button type="button" onClick={onDone}>Cancel</button>
        <button
          type="button"
          class="primary"
          disabled={busy || !form.url.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await api("POST", `/api/users/${u.id}/servers`, form);
              await loadUsers();
              onDone();
            } catch (err) {
              toast(errText(err), "error");
            }
            setBusy(false);
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Reader keys — Calibre's DeDRM settings, shown and edited in place.
 *
 * Nothing here is stored by Pocket Sync: the serials are read from and written
 * to Calibre's own `dedrm.json`, so anything already configured in Calibre's GUI
 * simply shows up, and removing Pocket Sync leaves it all intact. Adobe and
 * Kindle-app keys are listed as counts only — DeDRM harvests those itself and
 * they are not ours to hand out.
 *
 * The whole section is loopback-only. A serial decrypts someone's purchases, so
 * it must not be readable over the network when `webHost` is `0.0.0.0`.
 */
function ReaderKeys() {
  const [keys, setKeys] = useState<CalibreKeys | null>(null);
  const [serial, setSerial] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setKeys(await api<CalibreKeys>("GET", "/api/calibre/keys"));
    } catch {
      // Calibre missing is normal and already reported by the dependency banner.
      setKeys(null);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  if (!keys?.local) return null;
  const stale = keys.stalePlugins ?? [];

  return (
    <div class="folders">
      <h2>Reader keys</h2>
      <p class="muted">
        Kept in Calibre's own DeDRM settings, not in Pocket Sync. If you already set DeDRM up in
        Calibre, everything here is already done. A Kindle's serial is on the reader under{" "}
        <strong>Settings → Device Info</strong>.
      </p>

      {stale.length > 0 && (
        <div class="folder-row warn">
          <div>
            <strong>{stale.length} obsolete DRM plugin(s) can no longer load</strong>
            <div class="muted small">
              {stale.join(", ")}{" "}
              — superseded by DeDRM, and the reason Calibre can appear to have DRM support when it
              has none.
            </div>
          </div>
          <span class="spacer" />
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("POST", "/api/calibre/plugins/prune");
                await Promise.all([reload(), loadStatus()]);
                toast("Removed the obsolete plugins", "ok");
              } catch (err) {
                toast(errText(err), "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove them
          </button>
        </div>
      )}

      {keys.serials.map((s) => (
        <div key={s} class="folder-row">
          <div>
            <strong>Kindle {s}</strong>
            <div class="muted small">device serial</div>
          </div>
          <span class="spacer" />
          <button
            type="button"
            class="danger"
            onClick={async () => {
              if (!confirm(`Remove the serial ${s} from Calibre's DeDRM settings?`)) return;
              try {
                await api("DELETE", `/api/calibre/keys/serial/${encodeURIComponent(s)}`);
                await reload();
              } catch (err) {
                toast(errText(err), "error");
              }
            }}
          >
            Remove
          </button>
        </div>
      ))}

      {(keys.adobeKeys || keys.kindleKeys)
        ? (
          <p class="muted small">
            Calibre also has{" "}
            {keys.adobeKeys ? `${keys.adobeKeys} Adobe Digital Editions key(s)` : ""}
            {keys.adobeKeys && keys.kindleKeys ? " and " : ""}
            {keys.kindleKeys ? `${keys.kindleKeys} Kindle for Mac/PC key(s)` : ""}, found
            automatically. Nothing to do for books bought on those.
          </p>
        )
        : null}

      <div class="toolbar">
        <input
          placeholder="Kindle serial number (e-ink readers only)"
          spellcheck={false}
          value={serial}
          onInput={(e) => setSerial(e.currentTarget.value)}
        />
        <button
          type="button"
          class="primary"
          onClick={async () => {
            if (!serial.trim()) return;
            try {
              await api("POST", "/api/calibre/keys/serial", { serial });
              setSerial("");
              await reload();
            } catch (err) {
              toast(errText(err), "error");
            }
          }}
        >
          Add serial
        </button>
      </div>
    </div>
  );
}

function ProfileEditor({ profile }: { profile: Profile }) {
  const [p, setP] = useState<Profile>(profile);
  const server = JSON.stringify(profile);
  useEffect(() => setP(profile), [server]);

  const patch = (v: Partial<Profile>) => setP((cur) => ({ ...cur, ...v }));

  return (
    <div class="profile">
      <div class="rule">
        <Field label="Name" width="grow">
          <input value={p.name} onInput={(e) => patch({ name: e.currentTarget.value })} />
        </Field>
        <Field label="Device" width="narrow">
          <select
            value={p.device_model}
            onChange={(e) => patch({ device_model: e.currentTarget.value })}
          >
            {["X4", "X3"].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Field>
        <Field label="JPEG quality" width="narrow">
          <input
            type="number"
            min="1"
            max="100"
            value={String(p.jpeg_quality)}
            onInput={(e) => patch({ jpeg_quality: Number(e.currentTarget.value) })}
          />
        </Field>
      </div>
      <div class="checks">
        <Check
          label="Grayscale"
          checked={!!p.grayscale}
          onChange={(v) => patch({ grayscale: v ? 1 : 0 })}
        />
        <Check
          label="Auto-crop margins"
          checked={!!p.auto_crop}
          onChange={(v) => patch({ auto_crop: v ? 1 : 0 })}
        />
        <Check
          label="Split text + strip fonts"
          checked={!!p.split_text}
          onChange={(v) => patch({ split_text: v ? 1 : 0 })}
        />
      </div>
      <div class="actions">
        <button
          type="button"
          class="danger"
          onClick={async () => {
            if (!confirm(`Delete profile “${p.name}”?`)) return;
            await api("DELETE", `/api/profiles/${p.id}`);
            loadProfiles();
          }}
        >
          Delete
        </button>
        <button
          type="button"
          class="primary"
          onClick={async () => {
            await api("PUT", `/api/profiles/${p.id}`, {
              name: p.name,
              device_model: p.device_model,
              jpeg_quality: p.jpeg_quality,
              grayscale: p.grayscale ? 1 : 0,
              auto_crop: p.auto_crop ? 1 : 0,
              split_text: p.split_text ? 1 : 0,
            });
            toast("Profile saved", "ok");
            loadProfiles();
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
