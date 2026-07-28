// One line above the shelf saying what the app is busy with, and nothing at all
// when it isn't. The detail — stages, errors, the buttons a blocked import
// needs — lives on the Activity tab, which this is the way into.
import { activityFrom, devices, inbox, status, syncRun, tab } from "./store.ts";

export function ActivityBar() {
  const jobs = inbox.value;
  const attention = jobs.filter((j) => j.state === "blocked" || j.state === "failed");
  const running = jobs.filter((j) => j.state === "running");
  const run = syncRun.value;
  const syncing = status.value?.syncing || devices.value.some((d) => d.state.syncing);

  let kind = "";
  let label = "";
  /** null renders as motion without a claim about how far along we are. */
  let fraction: number | null = null;

  if (attention.length) {
    // Blocked imports are the reason this is not a toast: they wait for a person.
    kind = "warn";
    label = `${attention.length} import${attention.length === 1 ? "" : "s"} need${
      attention.length === 1 ? "s" : ""
    } attention`;
  } else if (run) {
    // The engine knows how many books the run has; whole books done plus the
    // fraction of the one in flight. Never goes backwards mid-run.
    fraction = (run.index - 1 + run.percent) / run.total;
    label = run.label;
  } else if (running.length) {
    // Imports are discovered as the scanner walks, so there is no honest total
    // to divide by — a count and motion, rather than an invented percentage.
    label = `Importing ${running.length} file${running.length === 1 ? "" : "s"}…`;
  } else if (syncing) {
    label = "Syncing…";
  } else {
    return null;
  }

  return (
    <button
      type="button"
      class={`activity-bar ${kind}`}
      title="Show activity"
      onClick={() => {
        activityFrom.value = tab.value;
        tab.value = "activity";
      }}
    >
      <span class="activity-label">{label}</span>
      <span class="activity-track">
        <span
          class={fraction === null ? "activity-fill indeterminate" : "activity-fill"}
          style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
        />
      </span>
      {fraction !== null && <span class="muted small">{`${Math.round(fraction * 100)}%`}</span>}
      <span class="muted small">Details →</span>
    </button>
  );
}
