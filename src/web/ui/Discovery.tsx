// Finding readers. Everything about one reader lives on its own page in the
// library rail; what is left here is the network side — is the app looking, is
// anything answering, and which readers it knows about.
import { useState } from "preact/hooks";
import { api, errText, fmtDate } from "./api.ts";
import {
  devices,
  loadDevices,
  loadSettings,
  loadStatus,
  setScope,
  status,
  tab,
  toast,
} from "./store.ts";

export function Discovery() {
  const [scanning, setScanning] = useState(false);

  return (
    <div class="folders">
      <h2>Readers</h2>

      <div class="toolbar">
        <button
          type="button"
          disabled={scanning}
          onClick={async () => {
            setScanning(true);
            try {
              await api("POST", "/api/devices/discover");
              await loadDevices();
              const online = devices.value.filter((d) => d.state.online).length;
              toast(`${online} device(s) online`, "ok");
            } catch (err) {
              toast(errText(err), "error");
            }
            setScanning(false);
          }}
        >
          {scanning ? "Scanning…" : "Scan now"}
        </button>
        <DiscoveryStatus />
      </div>

      <DiscoveryWarning />

      {devices.value.length === 0
        ? (
          <p class="muted">
            No readers yet. Wake one on the same Wi-Fi, or add its IP under{" "}
            <strong>Discovery → manual hosts</strong> below.
          </p>
        )
        : devices.value.map((d) => (
          <div key={d.id} class="folder-row">
            <span class={`dot${d.state.online ? " ok" : ""}`} />
            <div>
              <button
                type="button"
                class="link"
                onClick={() => {
                  setScope({ kind: "device", id: d.id });
                  tab.value = "library";
                }}
              >
                {d.name || d.model || d.id}
              </button>
              <div class="muted small">
                {`${d.state.host || d.last_ip || "?"} · seen ${fmtDate(d.last_seen)}`}
              </div>
            </div>
            <span class="spacer" />
            <span class="muted small">
              {d.id_strategy === "ip" ? "identity: address" : `identity: ${d.id_strategy}`}
            </span>
          </div>
        ))}

      <p class="muted small">Readers are matched by their /api/status identity, not their IP.</p>
    </div>
  );
}

/**
 * Scanning is continuous, so say so. Without this the "Scan now" button implies
 * discovery is something you have to remember to do.
 */
function DiscoveryStatus() {
  const s = status.value?.discovery;
  if (!s) return null;
  if (!s.running) return <span class="warn">discovery is not running</span>;
  return (
    <span class="muted">
      {s.sweeping
        ? "checking now…"
        : `checking every ${s.intervalSec}s${
          s.lastSweepAt ? ` · last ${fmtDate(s.lastSweepAt)}` : ""
        }`}
    </span>
  );
}

/**
 * The failure this exists for: discovery switched off looks identical to "no
 * reader on the network". The app sweeps on schedule either way and finds
 * nothing, because with broadcast off and no manual hosts there is no address to
 * probe. A platform blocking our LAN traffic looks the same again, so that gets
 * its own line once several sweeps have gone unanswered.
 */
function DiscoveryWarning() {
  const s = status.value?.discovery;
  if (!s) return null;

  if (!s.broadcast || !s.running) {
    return (
      <div class="banner error">
        <strong>
          {s.blind ? "Nothing is being looked for." : "Automatic discovery is off."}
        </strong>
        <span>
          {s.blind
            ? "Wi-Fi discovery is switched off and no manual hosts are set, so no reader can be found."
            : `Only the ${s.manualHosts} manual host(s) are checked; readers are not searched for on Wi-Fi.`}
        </span>
        <span class="spacer" />
        <button
          type="button"
          onClick={async () => {
            await api("PUT", "/api/settings", { discovery: { enabled: true } });
            await Promise.all([loadSettings(), loadStatus(), loadDevices()]);
            toast("Wi-Fi discovery turned on", "ok");
          }}
        >
          Turn discovery on
        </button>
      </div>
    );
  }

  if (s.silent && devices.value.length === 0) {
    return (
      <div class="banner">
        <strong>Looking, but nothing has answered.</strong>
        <span>
          {s.platform === "darwin"
            ? "Either no reader is awake on this Wi-Fi, or macOS is blocking local network access — check System Settings → Privacy & Security → Local Network."
            : "Either no reader is awake on this Wi-Fi, or a firewall is dropping the broadcast. Adding the reader's IP as a manual host bypasses it."}
        </span>
      </div>
    );
  }

  return null;
}
