/**
 * Declare local-network access in a macOS .app bundle.
 *
 *   deno run -A scripts/mac_localnet.ts                 # patch the cached deno desktop shells
 *   deno run -A scripts/mac_localnet.ts --app dist/X.app
 *
 * Why this exists: from macOS 15 on, reaching anything on the LAN — our UDP
 * discovery broadcast and the plain HTTP probe alike — needs the user's consent,
 * and consent is asked for per app bundle. An app whose Info.plist has no
 * `NSLocalNetworkUsageDescription` is not prompted for and not listed under
 * Privacy & Security › Local Network: it is simply denied, silently, forever.
 *
 * `deno desktop` runs our code inside its own prebuilt `laufey_webview.app`,
 * which ships without that key, so every LAN packet from the desktop build is
 * dropped while the identical code run from a terminal (where the terminal owns
 * the grant) works. Adding the key restores the prompt.
 *
 * Editing Info.plist invalidates the bundle's signature, so it is re-signed
 * ad hoc afterwards — the same signature `deno desktop` applies itself.
 */

const KEY = "NSLocalNetworkUsageDescription";
const REASON =
  "Pocket Sync finds your e-reader on your Wi-Fi network and sends books to it directly.";

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  const out = await new Deno.Command(cmd, { args, stdout: "null", stderr: "piped" }).output();
  return { ok: out.success, err: new TextDecoder().decode(out.stderr).trim() };
}

/** Every `deno desktop` webview shell in the Deno cache, for any laufey version. */
export function cachedDesktopShells(): string[] {
  const denoDir = Deno.env.get("DENO_DIR") ??
    `${Deno.env.get("HOME") ?? "."}/Library/Caches/deno`;
  const found: string[] = [];
  let versions: Deno.DirEntry[];
  try {
    versions = [...Deno.readDirSync(`${denoDir}/laufey`)];
  } catch {
    return found; // desktop shell never downloaded
  }
  for (const version of versions) {
    const webview = `${denoDir}/laufey/${version.name}/webview`;
    let targets: Deno.DirEntry[];
    try {
      targets = [...Deno.readDirSync(webview)];
    } catch {
      continue;
    }
    for (const target of targets) {
      // Only Darwin targets are .app bundles, and only the host arch can run.
      const app = `${webview}/${target.name}/laufey_webview.app`;
      try {
        if (Deno.statSync(`${app}/Contents/Info.plist`).isFile) found.push(app);
      } catch { /* not a macOS shell */ }
    }
  }
  return found;
}

/**
 * Add the usage description if it is missing. Returns true when the bundle was
 * changed, so callers can tell the user a restart is needed.
 */
export async function ensureLocalNetworkUsage(app: string, reason = REASON): Promise<boolean> {
  const plist = `${app}/Contents/Info.plist`;
  const read = await new Deno.Command("plutil", {
    args: ["-extract", KEY, "raw", "-o", "-", plist],
    stdout: "null",
    stderr: "null",
  }).output();
  if (read.success) return false; // already declared

  const insert = await run("plutil", ["-insert", KEY, "-string", reason, plist]);
  if (!insert.ok) throw new Error(`could not edit ${plist}: ${insert.err}`);

  // An unsigned edit leaves a bundle macOS refuses to launch ("is damaged").
  const sign = await run("codesign", ["--force", "--sign", "-", app]);
  if (!sign.ok) throw new Error(`could not re-sign ${app}: ${sign.err}`);
  return true;
}

if (import.meta.main) {
  if (Deno.build.os !== "darwin") Deno.exit(0); // no-op elsewhere, so tasks can depend on it

  const explicit = Deno.args[Deno.args.indexOf("--app") + 1];
  const apps = Deno.args.includes("--app") ? [explicit] : cachedDesktopShells();
  if (!apps.length) {
    console.log("mac_localnet: no macOS app bundle found; nothing to do");
    Deno.exit(0);
  }

  let changed = 0;
  for (const app of apps) {
    try {
      if (await ensureLocalNetworkUsage(app)) {
        changed++;
        console.log(`mac_localnet: declared local network access in ${app}`);
      }
    } catch (err) {
      console.error(`mac_localnet: ${err instanceof Error ? err.message : err}`);
      Deno.exit(1);
    }
  }
  if (changed) {
    console.log(
      "mac_localnet: macOS will ask for Local Network permission the next time the app runs",
    );
  }
}
