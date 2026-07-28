/**
 * Entrypoint for both modes:
 *   deno task start      → headless daemon (no window, no tray)
 *   deno desktop …       → same daemon plus the menu-bar shell
 *
 * Under `deno desktop` the runtime picks a port, exports it as
 * DENO_SERVE_ADDRESS and points the startup window at the first Deno.serve.
 * A second listener on the configured port serves ordinary browsers.
 */
import { App } from "./app.ts";
import { createHandler } from "./web/server.ts";

const app = new App();
const handler = createHandler(app);

const desktopAddress = Deno.env.get("DENO_SERVE_ADDRESS");
let windowUrl: string | null = null;

if (desktopAddress) {
  // First listener: the one the startup window is pointed at.
  Deno.serve({
    onListen: ({ hostname, port }) => {
      windowUrl = `http://${hostname}:${port}`;
      app.log.info("web.window", `Desktop window server on ${windowUrl}`);
    },
  }, (req, info) => handler(req, info));
}

const cfg = app.config.current;
try {
  Deno.serve({
    port: cfg.webPort,
    hostname: cfg.webHost,
    onListen: ({ hostname, port }) =>
      app.log.info("web.listen", `Web UI on http://${hostname}:${port}`),
  }, (req, info) => handler(req, info));
} catch (err) {
  const busy = err instanceof Deno.errors.AddrInUse;
  app.log.error(
    "web.listen.failed",
    `Could not bind ${cfg.webHost}:${cfg.webPort} (another instance running?): ${err}`,
  );
  // Headless has no other way in, so carrying on would leave a second daemon
  // running invisibly against the same database while the browser shows the
  // *other* instance — which is indistinguishable from this one being broken.
  // The desktop build keeps going: its window has its own listener above.
  if (!desktopAddress) {
    console.error(
      busy
        ? `\nPocket Sync is already running on ${cfg.webHost}:${cfg.webPort}.\n` +
          `Open http://${cfg.webHost}:${cfg.webPort} to use it, quit it first, or change ` +
          `webPort in the settings.\n`
        : `\nPocket Sync could not serve on ${cfg.webHost}:${cfg.webPort}: ${err}\n`,
    );
    await app.stop().catch(() => {});
    Deno.exit(1);
  }
}

if (!windowUrl) windowUrl = `http://127.0.0.1:${cfg.webPort}`;

let shell: { dispose(): void } | null = null;

/**
 * Window and tray creation must happen after this module finishes evaluating:
 * the desktop runtime starts its native event loop once the main module
 * returns, and constructing a window before that blocks the JS thread (which
 * would also stall the HTTP servers). Service startup rides along on the same
 * tick for the same reason.
 */
setTimeout(async () => {
  await app.start();

  if (desktopAddress) {
    // A broken shell must never take the daemon down with it.
    try {
      const { isDesktop, startDesktopShell } = await import("./desktop/shell.ts");
      if (isDesktop()) {
        const startHidden = Deno.env.get("POCKET_START_HIDDEN") === "1";
        shell = startDesktopShell(app, windowUrl!, { startHidden, hideDock: startHidden });
      } else {
        app.log.warn(
          "desktop.unavailable",
          "Desktop APIs missing; running without a menu-bar icon",
        );
      }
    } catch (err) {
      app.log.error("desktop.failed", `Menu-bar shell failed to start: ${err}`);
    }
  }
}, 0);

const shutdown = async () => {
  shell?.dispose();
  await app.stop();
  Deno.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(signal, () => {
      shutdown().catch(() => Deno.exit(1));
    });
  } catch { /* signal not supported on this platform */ }
}
