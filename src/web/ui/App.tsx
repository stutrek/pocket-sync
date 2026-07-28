import { Activity } from "./Activity.tsx";
import { api, fmtDate } from "./api.ts";
import { BookDrawer } from "./BookDrawer.tsx";
import { Library, useGlobalDropGuard } from "./Library.tsx";
import { SettingsView } from "./Settings.tsx";
import {
  activityFrom,
  connected,
  detailBookId,
  loadStatus,
  status,
  statusError,
  tab,
  toast,
  toasts,
} from "./store.ts";
import type { Deps, Tab } from "./types.ts";

const TABS: [Tab, string][] = [
  ["library", "Library"],
  ["settings", "Settings"],
  ["activity", "Activity"],
];

export function App() {
  useGlobalDropGuard();

  const current = tab.value;

  return (
    <>
      <header class="topbar">
        <div class="brand">
          <HealthDot />
          <strong>Pocket Sync</strong>
        </div>
        <nav class="tabs">
          {TABS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              class={current === id ? "active" : ""}
              onClick={() => {
                // Picking the tab directly is not a detour, so drop the way back.
                activityFrom.value = null;
                tab.value = id;
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <div class="status">{statusError.value ?? summary()}</div>
      </header>

      <Banners />

      <main>
        {current === "library" && <Library />}
        {current === "settings" && <SettingsView />}
        {current === "activity" && <Activity />}
      </main>

      {detailBookId.value && <BookDrawer id={detailBookId.value} />}
      <Toasts />
    </>
  );
}

function summary(): string {
  const s = status.value;
  if (!s) return "…";
  const devices = `${s.devicesOnline}/${s.devices} device${s.devices === 1 ? "" : "s"} online`;
  const sync = s.syncing ? "syncing…" : `last sync ${fmtDate(s.lastSync)}`;
  const inbox = s.inbox ? ` · ${s.inbox} need attention` : "";
  return `${s.books} book${s.books === 1 ? "" : "s"} · ${devices} · ${sync}${inbox}` +
    (s.autoSyncEnabled ? "" : " · auto-sync paused");
}

function HealthDot() {
  if (!connected.value) return <span class="dot err" />;
  const s = status.value;
  const kind = s?.syncing ? "warn" : (s?.devicesOnline ?? 0) > 0 ? "ok" : "";
  return <span class={`dot ${kind}`} />;
}

/**
 * Setup problems belong in front of the user, not buried in the log — but only
 * once we actually know. Before the first probe every dependency reads as
 * missing, and announcing that on every launch trains people to ignore banners.
 */
function Banners() {
  const deps: Deps | undefined = status.value?.deps;
  if (!deps || !deps.checked) return null;

  return (
    <div>
      {deps.engine && !deps.engine.ok && (
        <div class="banner error">
          <strong>Resampling unavailable.</strong>
          <span>{deps.engine.error || "The image engine did not start."}</span>
          <span>Books can still be sent unoptimized.</span>
        </div>
      )}
      {deps.calibre && !deps.calibre.convert && (
        <div class="banner">
          <strong>Calibre not found.</strong>
          <span>
            EPUB files work as normal; MOBI, PDF, DOCX and others need Calibre to convert.
          </span>
          <a href="https://calibre-ebook.com/download" target="_blank" rel="noreferrer">
            Install Calibre
          </a>
          <span class="spacer" />
          <RecheckButton />
        </div>
      )}
    </div>
  );
}

function RecheckButton() {
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.currentTarget.disabled = true;
        await api("GET", "/api/health?recheck=1");
        await loadStatus();
        toast("Re-checked dependencies", "ok");
      }}
    >
      Re-check
    </button>
  );
}

function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => <div key={t.id} class={`toast ${t.kind ?? ""}`}>{t.message}</div>)}
    </div>
  );
}
