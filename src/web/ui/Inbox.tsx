import { useState } from "preact/hooks";
import { api, errText } from "./api.ts";
import { Modal } from "./components.tsx";
import { inbox, loadBooks, loadInbox, loadStatus, toast } from "./store.ts";
import type { ImportJob } from "./types.ts";

/** What a blocked job is waiting for, in the user's terms. */
const BLOCKED: Record<string, { label: string; action?: string }> = {
  "drm-key": {
    // Only e-ink downloads are unlocked by a serial. Books from Kindle for
    // Mac/PC use the app's own key, which Settings can read out.
    label: "DRM-protected — no key that opens this book is configured",
    action: "Add a key",
  },
  "drm-plugin": {
    label: "DRM-protected — needs the DeDRM plugin in Calibre",
    action: "Install plugin",
  },
  "drm-plugin-disabled": {
    label: "DRM-protected — the DeDRM plugin is switched off in Calibre",
    action: "Recheck",
  },
  "drm-kfx": {
    label: "Kindle KFX — its DRM cannot be removed by any available tool",
  },
  calibre: { label: "Needs Calibre to convert this format", action: "Recheck" },
  "calibre-busy": {
    label: "Calibre is open — it locks its database while running. Quit it and retry.",
    action: "Retry",
  },
};

const STAGE_LABEL: Record<string, string> = {
  queued: "queued",
  hashing: "reading…",
  drm: "checking protection…",
  metadata: "reading metadata…",
  converting: "converting…",
  ready: "added",
};

/**
 * Imports are durable and can block on the user, so this is a place things wait
 * — not a toast. Rows only disappear once they are genuinely done.
 */
export function Inbox() {
  const jobs = inbox.value;
  if (!jobs.length) return null;

  const attention = jobs.filter((j) => j.state === "blocked" || j.state === "failed").length;

  return (
    <div class="inbox">
      <div class="inbox-head">
        <strong>Inbox</strong>
        <span class="muted">
          {attention
            ? `${attention} need${attention === 1 ? "s" : ""} attention`
            : `${jobs.length} recent`}
        </span>
      </div>
      {jobs.map((job) => <Row key={job.id} job={job} />)}
    </div>
  );
}

function Row({ job }: { job: ImportJob }) {
  const blocked = job.needs ? BLOCKED[job.needs] : undefined;
  const [asking, setAsking] = useState(false);

  const retry = async () => {
    await api("POST", `/api/inbox/${job.id}/retry`);
    await Promise.all([loadInbox(), loadBooks()]);
  };

  return (
    <div class={`inbox-row ${job.state}`}>
      <span class="name" title={job.path}>{job.filename}</span>

      {job.state === "running" && <span class="muted">{STAGE_LABEL[job.stage] ?? job.stage}</span>}
      {job.state === "done" && <span class="ok">added ✓</span>}
      {job.state === "failed" && <span class="err">{job.error ?? "failed"}</span>}
      {job.state === "blocked" && <span class="warn">{job.error ?? blocked?.label}</span>}

      <span class="spacer" />

      {(job.state === "failed" || job.state === "blocked") && (
        <button
          type="button"
          onClick={async () => {
            try {
              // The serial is the one thing we can collect ourselves; everything
              // else here is either a download or just a re-probe.
              if (job.needs === "drm-key") {
                setAsking(true);
                return;
              }
              if (job.needs === "drm-plugin") {
                toast("Installing the DeDRM plugin into Calibre…");
                await api("POST", "/api/calibre/dedrm");
                toast("DeDRM installed", "ok");
              }
              await retry();
            } catch (err) {
              toast(errText(err), "error");
            }
          }}
        >
          {blocked?.action ?? "Retry"}
        </button>
      )}
      {job.state !== "running" && (
        <button
          type="button"
          title="Dismiss"
          onClick={async () => {
            await api("DELETE", `/api/inbox/${job.id}`);
            loadInbox();
          }}
        >
          ✕
        </button>
      )}

      {asking && <SerialPrompt onClose={() => setAsking(false)} onSaved={retry} />}
    </div>
  );
}

/**
 * Collect a Kindle serial and retry in one action.
 *
 * The serial goes straight into Calibre's own DeDRM settings — we store nothing
 * — so anyone who already configured DeDRM in Calibre's GUI never sees this.
 */
export function SerialPrompt(
  { onClose, onSaved }: { onClose: () => void; onSaved?: () => Promise<void> },
) {
  const [serial, setSerial] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!serial.trim() || busy) return;
    setBusy(true);
    try {
      await api("POST", "/api/calibre/keys/serial", { serial });
      await loadStatus();
      onClose();
      toast("Serial added to Calibre's DeDRM settings", "ok");
      await onSaved?.();
    } catch (err) {
      toast(errText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add your Kindle's serial number" onClose={onClose}>
      <p class="muted">
        On your Kindle:{" "}
        <strong>Settings → Device Info</strong>. It is 16 letters and digits, and the capitalisation
        matters.
      </p>
      <input
        type="text"
        autofocus
        spellcheck={false}
        placeholder="B0XXXXXXXXXXXXXX"
        value={serial}
        onInput={(e) => setSerial(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <p class="muted">
        Saved into Calibre's DeDRM settings, not into Pocket Sync. If Calibre is open, restart it
        for the change to take effect.
      </p>
      <div class="toolbar">
        <span class="spacer" />
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" class="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : "Save and retry"}
        </button>
      </div>
    </Modal>
  );
}
