// Everything the app is doing or has done: imports that need you first, then
// the running log. One place to look, reached from the progress bar above the
// shelf — the imports used to sit in the library view and pushed the books down.
import { useLayoutEffect, useRef } from "preact/hooks";
import { Inbox } from "./Inbox.tsx";
import { activityFrom, follow, inbox, LEVELS, logLevel, logs, tab } from "./store.ts";
import type { LogLevel } from "./types.ts";

export function Activity() {
  const view = useRef<HTMLDivElement>(null);
  const visible = logs.value.filter((e) => LEVELS[e.level] >= LEVELS[logLevel.value]);

  // Pin to the bottom after the new lines are in the DOM but before paint, so
  // following a busy sync doesn't flicker.
  useLayoutEffect(() => {
    if (follow.value && view.current) view.current.scrollTop = view.current.scrollHeight;
  });

  const from = activityFrom.value;

  return (
    <section class="view">
      {/* Arriving here from the progress bar is a detour, not a destination. */}
      {from && (
        <div class="toolbar">
          <button
            type="button"
            onClick={() => {
              tab.value = from;
              activityFrom.value = null;
            }}
          >
            ← Back to {from === "library" ? "library" : from}
          </button>
        </div>
      )}

      {inbox.value.length > 0 && <Inbox />}

      <div class="toolbar">
        <select
          value={logLevel.value}
          onChange={(e) => (logLevel.value = e.currentTarget.value as LogLevel)}
        >
          <option value="debug">All</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
        <label class="check">
          <input
            type="checkbox"
            checked={follow.value}
            onChange={(e) => (follow.value = e.currentTarget.checked)}
          />
          Follow
        </label>
        <span class="spacer" />
        <button type="button" onClick={() => (logs.value = [])}>Clear view</button>
      </div>
      <div class="logs" ref={view}>
        {visible.map((e, i) => (
          <div key={`${e.ts}-${i}`} class={`log-line ${e.level}`}>
            <span class="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <span class="ev">{e.event}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
