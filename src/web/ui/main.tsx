// Entry point. Bundled to src/web/static/app.bundle.js by `deno task ui`, which
// server.ts then embeds into the binary as text.
import { render } from "preact";
import { App } from "./App.tsx";
import { connectEvents, loadRecentLogs, loadStatus, refreshAll, tab } from "./store.ts";
import type { Tab } from "./types.ts";

const TAB_NAMES = ["library", "settings", "activity"];

function start() {
  // The tray's "View activity" opens /?tab=activity; ?tab=logs is the old name
  // and may still be sitting in someone's bookmark.
  const wanted = new URLSearchParams(location.search).get("tab");
  const name = wanted === "logs" ? "activity" : wanted;
  if (name && TAB_NAMES.includes(name)) tab.value = name as Tab;

  const root = document.getElementById("app")!;
  render(<App />, root);

  refreshAll();
  loadRecentLogs();
  connectEvents();
  setInterval(loadStatus, 15000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
