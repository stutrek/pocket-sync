/**
 * "Start at login", implemented per platform so the packaged app needs no
 * install script:
 *   macOS   — a LaunchAgent plist (also restarts the app if it crashes)
 *   Windows — an HKCU Run registry value
 *   Linux   — an XDG autostart .desktop file
 */
import type { Logger } from "../core/log.ts";

const LABEL = "com.xteink.sync";

/** The command that launches this app again, as the OS should record it. */
export function launchCommand(): string {
  const exe = Deno.execPath();
  if (Deno.build.os === "darwin") {
    // …/XteinkSync.app/Contents/MacOS/<exe> — launch the bundle's executable.
    return exe;
  }
  return exe;
}

function home(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
}

function plistPath(): string {
  return `${home()}/Library/LaunchAgents/${LABEL}.plist`;
}

function desktopPath(): string {
  const config = Deno.env.get("XDG_CONFIG_HOME") || `${home()}/.config`;
  return `${config}/autostart/xteink-sync.desktop`;
}

export async function isEnabled(): Promise<boolean> {
  try {
    switch (Deno.build.os) {
      case "darwin":
        await Deno.stat(plistPath());
        return true;
      case "windows": {
        const out = await new Deno.Command("reg", {
          args: [
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "XteinkSync",
          ],
          stdout: "piped",
          stderr: "null",
        }).output();
        return out.code === 0;
      }
      default:
        await Deno.stat(desktopPath());
        return true;
    }
  } catch {
    return false;
  }
}

export async function setEnabled(enabled: boolean, log: Logger, dataDir: string): Promise<boolean> {
  try {
    if (Deno.build.os === "darwin") await macos(enabled, dataDir);
    else if (Deno.build.os === "windows") await windows(enabled);
    else await linux(enabled, dataDir);
    log.info("autostart", enabled ? "Start at login enabled" : "Start at login disabled");
    return await isEnabled();
  } catch (err) {
    log.error("autostart.failed", `Could not change start-at-login: ${err}`);
    return await isEnabled();
  }
}

async function macos(enabled: boolean, dataDir: string) {
  const path = plistPath();
  if (!enabled) {
    await new Deno.Command("launchctl", {
      args: ["bootout", `gui/${Deno.uid() ?? 0}/${LABEL}`],
      stdout: "null",
      stderr: "null",
    }).output().catch(() => {});
    await Deno.remove(path).catch(() => {});
    return;
  }
  await Deno.mkdir(`${home()}/Library/LaunchAgents`, { recursive: true });
  const logs = `${dataDir}/logs`;
  await Deno.mkdir(logs, { recursive: true });
  await Deno.writeTextFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${launchCommand()}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
    <key>XTEINK_START_HIDDEN</key><string>1</string>
    <key>XTEINK_DATA_DIR</key><string>${dataDir}</string>
  </dict>
  <key>StandardOutPath</key><string>${logs}/launchd.out.log</string>
  <key>StandardErrorPath</key><string>${logs}/launchd.err.log</string>
</dict>
</plist>
`,
  );
  const uid = Deno.uid() ?? 0;
  await new Deno.Command("launchctl", {
    args: ["bootout", `gui/${uid}/${LABEL}`],
    stdout: "null",
    stderr: "null",
  }).output().catch(() => {});
  await new Deno.Command("launchctl", {
    args: ["bootstrap", `gui/${uid}`, path],
    stdout: "null",
    stderr: "null",
  }).output();
}

async function windows(enabled: boolean) {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const args = enabled
    ? ["add", key, "/v", "XteinkSync", "/t", "REG_SZ", "/d", `"${launchCommand()}"`, "/f"]
    : ["delete", key, "/v", "XteinkSync", "/f"];
  const out = await new Deno.Command("reg", { args, stdout: "null", stderr: "piped" }).output();
  if (out.code !== 0 && enabled) {
    throw new Error(new TextDecoder().decode(out.stderr).trim() || `reg exited ${out.code}`);
  }
}

async function linux(enabled: boolean, dataDir: string) {
  const path = desktopPath();
  if (!enabled) {
    await Deno.remove(path).catch(() => {});
    return;
  }
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(
    path,
    `[Desktop Entry]
Type=Application
Name=Xteink Sync
Comment=Sync books to Xteink e-readers
Exec=env XTEINK_START_HIDDEN=1 XTEINK_DATA_DIR="${dataDir}" "${launchCommand()}"
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
}
