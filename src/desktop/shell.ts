import trayIcon from "../../assets/tray.png" with { type: "bytes" };
import trayIconDark from "../../assets/tray-dark.png" with { type: "bytes" };
import type { App } from "../app.ts";

/**
 * Menu-bar presence (§5.1). Loaded only when the Deno Desktop APIs exist, so
 * the headless daemon never imports it.
 */
export interface DesktopShell {
  refresh(): void;
  openLibrary(path?: string): void;
  dispose(): void;
}

// deno-lint-ignore no-explicit-any
type AnyDeno = any;

export function isDesktop(): boolean {
  return typeof (Deno as AnyDeno).Tray === "function" &&
    typeof (Deno as AnyDeno).BrowserWindow === "function";
}

export function startDesktopShell(
  app: App,
  uiUrl: string,
  opts: { startHidden?: boolean; hideDock?: boolean } = {},
): DesktopShell | null {
  const D = Deno as AnyDeno;
  if (!isDesktop()) return null;

  // The first construction adopts the implicit startup window.
  let win = new D.BrowserWindow({ title: "Xteink Sync", width: 1180, height: 820 });
  win.navigate(uiUrl);
  if (opts.startHidden) win.hide();
  if (opts.hideDock) {
    try {
      D.dock?.setVisible(false);
    } catch { /* not macOS */ }
  }

  const tray = new D.Tray();
  try {
    tray.setIcon(trayIcon);
    tray.setIconDark?.(trayIconDark);
  } catch (err) {
    app.log.warn("tray.icon", `Could not set tray icon: ${err}`);
  }

  const ensureWindow = () => {
    if (!win || win.isClosed()) {
      win = new D.BrowserWindow({ title: "Xteink Sync", width: 1180, height: 820 });
    }
    return win;
  };

  const openLibrary = (path = "/") => {
    const w = ensureWindow();
    w.navigate(uiUrl + path);
    w.show();
    w.focus();
  };

  const statusLine = () => {
    const s = app.status();
    if (s.syncing) return "Syncing…";
    const online = `${s.devicesOnline}/${s.devices} device${s.devices === 1 ? "" : "s"} online`;
    const last = s.lastSync ? `, last sync ${relative(s.lastSync)}` : "";
    return `Running — ${s.books} books, ${online}${last}`;
  };

  // Every menu item must carry `enabled` — the native side rejects the item
  // outright if the field is missing.
  const item = (label: string, id: string, enabled = true) => ({ item: { label, id, enabled } });

  const buildMenu = () => {
    const s = app.status();
    tray.setTooltip(`Xteink Sync — ${statusLine()}`);
    tray.setMenu([
      item(statusLine(), "status", false),
      "separator",
      item("Open library", "open"),
      item("View logs", "logs"),
      item("Sync now", "sync", s.devicesOnline > 0 && !s.syncing),
      item("Scan for devices", "scan"),
      "separator",
      item(app.config.current.autoSyncEnabled ? "Pause auto-sync" : "Resume auto-sync", "pause"),
      "separator",
      item("Quit Xteink Sync", "quit"),
    ]);
  };

  const onMenu = async (id: string) => {
    switch (id) {
      case "open":
        openLibrary("/");
        break;
      case "logs":
        openLibrary("/?tab=logs");
        break;
      case "scan":
        await app.devices.sweep();
        break;
      case "sync": {
        for (const d of app.devices.view()) {
          if (d.state.online) {
            app.sync.sync(d.id, "manual").catch((err) =>
              app.log.error("sync.failed", `Tray sync failed: ${err}`, { deviceId: d.id })
            );
          }
        }
        break;
      }
      case "pause": {
        const next = !app.config.current.autoSyncEnabled;
        app.config.update({ autoSyncEnabled: next });
        app.log.info("sync.pause", next ? "Auto-sync resumed" : "Auto-sync paused");
        break;
      }
      case "quit":
        await app.stop();
        Deno.exit(0);
    }
    buildMenu();
  };

  tray.addEventListener("menuclick", (e: { detail?: { id?: string } }) => {
    const id = e?.detail?.id;
    if (id) onMenu(id).catch((err) => app.log.error("tray.error", `Tray action failed: ${err}`));
  });
  tray.addEventListener("click", () => openLibrary("/"));

  buildMenu();

  // Keep the menu fresh without rebuilding it on every log line.
  let dirty = false;
  const unsubscribe = app.bus.subscribe((e) => {
    if (e.event.startsWith("sync.") || e.event.startsWith("device.") || e.event === "ingest.done") {
      dirty = true;
    }
  });
  const timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    buildMenu();
  }, 2000);

  app.log.info("tray.ready", "Menu-bar icon ready");

  return {
    refresh: buildMenu,
    openLibrary,
    dispose() {
      clearInterval(timer);
      unsubscribe();
      try {
        tray.destroy();
      } catch { /* already gone */ }
    },
  };
}

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
}
