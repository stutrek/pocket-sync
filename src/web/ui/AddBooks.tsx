// Getting books into the library.
//
// This used to live in Settings, next to socket timeouts and the log level —
// which put the single most important thing in the app in its junk drawer.
// Watching a folder and adopting an existing e-reader library are how books get
// here at all, so they belong to the Library, opened from the rail.
//
// There is no path text box anywhere in this file, and there must not be: an
// indexed file is readable and deletable through the API, so an endpoint taking
// an arbitrary path would be an arbitrary-file read-and-delete API. The root is
// picked once through the OS's own chooser, from this machine only, and
// everything after that is navigating inside it (src/core/roots.ts).
import { useEffect, useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import { Check, Modal } from "./components.tsx";
import { libraries, loadLibraries, loadRoot, loadStatus, root, toast } from "./store.ts";
import type { Browse, SourceList, SourcePreview } from "./types.ts";

export function AddBooks({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Add books" onClose={onClose}>
      <WatchedFolders />
      <Sources />
    </Modal>
  );
}

function WatchedFolders() {
  const [browse, setBrowse] = useState<Browse | null>(null);
  const [rel, setRel] = useState("");
  const [busy, setBusy] = useState(false);

  const r = root.value;

  const refresh = async (at = rel) => {
    if (!root.value?.chosen) return;
    try {
      setBrowse(await api<Browse>("GET", `/api/root/browse?rel=${encodeURIComponent(at)}`));
    } catch (err) {
      toast(errText(err), "error");
    }
  };

  useEffect(() => {
    loadRootAndFolders();
  }, []);
  useEffect(() => {
    refresh(rel);
  }, [r?.path, rel]);

  const pickRoot = async () => {
    setBusy(true);
    try {
      const out = await api<{ cancelled?: boolean; dropped?: string[] }>("POST", "/api/root/pick");
      if (!out.cancelled) {
        setRel("");
        await loadRootAndFolders();
        if (out.dropped?.length) {
          toast(`Stopped watching ${out.dropped.length} folder(s) outside the new root`, "ok");
        }
      }
    } catch (err) {
      toast(errText(err), "error");
    }
    setBusy(false);
  };

  const setWatched = async (entryRel: string, on: boolean) => {
    try {
      if (on) {
        await api("POST", "/api/libraries", { relPath: entryRel });
      } else {
        const lib = libraries.value.find((l) => l.relPath === entryRel);
        if (lib) await api("DELETE", `/api/libraries/${lib.id}`);
      }
      await Promise.all([loadLibraries(), loadStatus(), refresh()]);
    } catch (err) {
      toast(errText(err), "error");
    }
  };

  if (!r) return null;

  if (!r.chosen) {
    return (
      <div class="folders">
        <h3>Your books folder</h3>
        <p class="muted">
          Pick the one folder that holds your books. Pocket Sync only ever looks inside it, and you
          choose which folders within it to watch.
        </p>
        {r.canPick
          ? (
            <button type="button" class="primary" disabled={busy} onClick={pickRoot}>
              {busy ? "Waiting for the picker…" : "Choose folder…"}
            </button>
          )
          : (
            <p class="warn">
              {r.local
                ? "No folder chooser is available on this machine."
                : "Open Pocket Sync on the computer it is running on to choose the folder."}
            </p>
          )}
      </div>
    );
  }

  const crumbs = rel ? rel.split("/") : [];
  /** The root itself is watched, so everything under it is already covered. */
  const wholeLibrary = libraries.value.some((l) => l.relPath === "");

  return (
    <div class="folders">
      <h3>Watch a folder</h3>
      <p class="muted">
        Everything inside{" "}
        <code>{r.path}</code>. Watched folders appear in the library; their files are only ever
        read, never written.
      </p>

      <div class="crumbs">
        <button type="button" class="link" onClick={() => setRel("")}>All books</button>
        {crumbs.map((part, i) => (
          <span key={i}>
            {" / "}
            <button
              type="button"
              class="link"
              onClick={() => setRel(crumbs.slice(0, i + 1).join("/"))}
            >
              {part}
            </button>
          </span>
        ))}
      </div>

      {
        /* The root is a folder like any other — watching it means "my whole
          library", which is what most people want and used to be unreachable
          because this row was hidden at the top level. */
      }
      {browse && (
        <div class="folder-row">
          <div>
            <strong>{browse.rel === "" ? "Everything in this folder" : "This folder"}</strong>
            <div class="muted small">
              {browse.rel === ""
                ? "One folder covering your whole library, sub-folders included"
                : browse.rel}
            </div>
          </div>
          <span class="spacer" />
          <Check
            label="Watch"
            checked={browse.watched}
            onChange={(v) => setWatched(browse.rel, v)}
          />
        </div>
      )}

      {browse?.entries.length === 0 && <p class="muted">No sub-folders here.</p>}

      {browse?.entries.map((entry) => {
        const lib = libraries.value.find((l) => l.relPath === entry.rel);
        return (
          <div key={entry.rel} class="folder-row">
            <div>
              {entry.children > 0
                ? (
                  <button type="button" class="link" onClick={() => setRel(entry.rel)}>
                    {entry.name}/
                  </button>
                )
                : <strong>{entry.name}</strong>}
              <div class="muted small">
                {wholeLibrary && !entry.watched
                  ? "already covered by the whole library"
                  : lib
                  ? `${lib.books} book(s) indexed`
                  : `${entry.children} sub-folder(s)`}
              </div>
            </div>
            <span class="spacer" />
            {
              /* Watching a sub-folder of an already-watched whole library would
                index every file twice and show it twice on the shelf. */
            }
            {wholeLibrary && !entry.watched ? <span class="muted small">included</span> : (
              <Check
                label="Watch"
                checked={entry.watched}
                onChange={(v) => setWatched(entry.rel, v)}
              />
            )}
          </div>
        );
      })}

      <div class="toolbar">
        <span class="muted small">{`Root: ${r.path}`}</span>
        <span class="spacer" />
        {r.canPick && (
          <button type="button" disabled={busy} onClick={pickRoot}>Change folder…</button>
        )}
      </div>
    </div>
  );
}

const loadRootAndFolders = () => Promise.all([loadRoot(), loadLibraries(), loadStatus()]);

/**
 * Existing e-reader libraries on this machine, watched in place.
 *
 * Requiring someone to copy their Calibre library into a new folder is the wrong
 * answer, so these are the one thing watched outside the root — read-only, and
 * only ever reached by a fixed allowlist of source ids, never by a path in a
 * request body.
 *
 * Renders nothing when nothing is installed, which is most machines.
 */
function Sources() {
  const [state, setState] = useState<SourceList | null>(null);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [busy, setBusy] = useState("");

  const reload = async () => {
    try {
      setState(await api<SourceList>("GET", "/api/sources"));
    } catch {
      setState(null);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  if (!state?.local) return null;
  const installed = state.sources.filter((s) => s.installed);
  if (!installed.length) return null;

  return (
    <div class="folders">
      <h3>Books you already have</h3>
      <p class="muted">
        Watched where they are, never copied and never modified. New books added in these apps show
        up here on their own.
      </p>

      {installed.map((s) => (
        <div key={s.id} class="folder-row">
          <div>
            <strong>{s.label}</strong>
            <div class="muted small">
              {s.watching ? "Watching — read-only. " : ""}
              {s.note}
            </div>
          </div>
          <span class="spacer" />
          {s.watching ? <span class="muted small">added</span> : (
            <button
              type="button"
              disabled={busy === s.id}
              onClick={async () => {
                setBusy(s.id);
                try {
                  setPreview(await api<SourcePreview>("POST", `/api/sources/${s.id}/preview`));
                } catch (err) {
                  toast(errText(err), "error");
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === s.id ? "Looking…" : "Look inside"}
            </button>
          )}
        </div>
      ))}

      {preview && (
        <Modal title={preview.label} onClose={() => setPreview(null)}>
          <p>
            <strong>{preview.books}</strong> book{preview.books === 1 ? "" : "s"} in{" "}
            <code>{preview.path}</code>
            {preview.truncated ? " (showing the first 5000)" : ""}.
          </p>
          {preview.known > 0 && (
            <p class="muted">{preview.known} already in your library — those cost nothing.</p>
          )}
          {
            /* Say what will need setting up *before* anything is watched, so a
              protected library does not become a screen of identical failures. */
          }
          {preview.protected > 0 && (
            <p class={preview.dedrm && preview.keysConfigured ? "muted" : "warn"}>
              {preview.protected} protected. {!preview.dedrm
                ? "The DeDRM plugin is not installed in Calibre yet, so those will wait in the Inbox."
                : preview.keysConfigured === 0
                ? "No reader key is configured yet — set one up under Settings → Reader keys first."
                : "Your configured keys will be tried automatically."}
            </p>
          )}
          {preview.unopenable > 0 && (
            <p class="warn">
              {preview.unopenable}{" "}
              are KFX files that carry no DRM voucher and cannot be opened by anything Pocket Sync
              can drive. They will be listed with that explanation.
            </p>
          )}
          <p class="muted">
            Added read-only: these files are only ever read, and “Delete file” will not touch them.
          </p>
          <div class="toolbar">
            <span class="spacer" />
            <button type="button" onClick={() => setPreview(null)}>Cancel</button>
            <button
              type="button"
              class="primary"
              onClick={async () => {
                try {
                  await api("POST", `/api/sources/${preview.id}/enable`);
                  setPreview(null);
                  toast(`Watching ${preview.label}`, "ok");
                  await Promise.all([reload(), loadLibraries(), loadStatus()]);
                } catch (err) {
                  toast(errText(err), "error");
                }
              }}
            >
              Watch this library
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
