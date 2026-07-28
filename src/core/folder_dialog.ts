/**
 * A native "choose folder" dialog.
 *
 * Deno Desktop exposes no dialog API (checked against 2.9), so this drives the
 * OS's own chooser as a subprocess. That keeps the module headless-safe — it
 * imports nothing GUI, and simply returns `null` where no chooser exists — so
 * `src/web/server.ts` can use it without breaking `deno task start`.
 */

export interface DialogResult {
  path?: string;
  cancelled?: boolean;
  error?: string;
}

/** Is a folder chooser available on this machine? */
export function canPickFolder(): boolean {
  return Deno.build.os === "darwin" || Deno.build.os === "windows" ||
    Deno.build.os === "linux";
}

export async function pickFolder(title = "Choose your books folder"): Promise<DialogResult> {
  switch (Deno.build.os) {
    case "darwin":
      return await run("osascript", [
        "-e",
        `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`,
      ]);
    case "windows":
      return await run("powershell", [
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; " +
        `$d = New-Object System.Windows.Forms.FolderBrowserDialog; ` +
        `$d.Description = ${JSON.stringify(title)}; ` +
        `if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`,
      ]);
    case "linux": {
      // zenity is the common one; fall back to kdialog on KDE.
      const z = await run("zenity", ["--file-selection", "--directory", `--title=${title}`]);
      if (z.path || z.cancelled) return z;
      return await run("kdialog", ["--getexistingdirectory", "."]);
    }
    default:
      return { error: "no folder chooser on this platform" };
  }
}

async function run(cmd: string, args: string[]): Promise<DialogResult> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const path = new TextDecoder().decode(out.stdout).trim();
    if (out.code !== 0 || !path) {
      // Every chooser reports a user cancel as a non-zero exit with no path.
      return { cancelled: true };
    }
    return { path };
  } catch (err) {
    return { error: `${cmd} is unavailable: ${err}` };
  }
}
