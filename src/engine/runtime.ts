import { UntarStream } from "@std/tar/untar-stream";
import type { Logger } from "../core/log.ts";
import type { Paths } from "../core/paths.ts";

/**
 * The Python runtime (CPython + Pillow + lxml) is embedded in the app by
 * `deno desktop --include build/python-runtime.tar.gz` and unpacked into the
 * data dir on first run. That is what makes the download double-click usable:
 * no system Python, no pip, no setup script.
 *
 * Built by scripts/fetch_python.ts. When the archive is absent (a plain
 * `deno run` during development) everything here degrades to "no bundle" and
 * the sidecar falls back to a system interpreter.
 */

const ARCHIVE = new URL("../../build/python-runtime.tar.gz", import.meta.url);
const STAMP = ".bundle-version";

/** Bumped by the build when the archive changes; see scripts/package.ts. */
export const BUNDLE_VERSION = "cpython-3.12.13+20260718";

export function bundledPythonExe(paths: Paths): string {
  return Deno.build.os === "windows"
    ? `${paths.pythonDir}/python.exe`
    : `${paths.pythonDir}/bin/python3`;
}

export async function hasBundledArchive(): Promise<boolean> {
  try {
    const f = await Deno.open(ARCHIVE, { read: true });
    f.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the bundled interpreter is unpacked and current. Returns its path, or
 * null when the app was built without a runtime bundle.
 */
export async function ensurePythonRuntime(
  paths: Paths,
  log: Logger,
): Promise<string | null> {
  const exe = bundledPythonExe(paths);
  const stampPath = `${paths.pythonDir}/${STAMP}`;

  try {
    const current = (await Deno.readTextFile(stampPath)).trim();
    if (current === BUNDLE_VERSION) {
      await Deno.stat(exe);
      return exe;
    }
  } catch { /* not installed yet, or a partial install */ }

  if (!await hasBundledArchive()) {
    log.debug("runtime.none", "No Python runtime bundled; using a system interpreter");
    return null;
  }

  const started = performance.now();
  log.info("runtime.install", `Unpacking the bundled Python runtime (${BUNDLE_VERSION})…`);

  const staging = `${paths.engineDir}/.python-new`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await Deno.mkdir(staging, { recursive: true });

  const archive = await Deno.open(ARCHIVE, { read: true });
  let files = 0;
  for await (
    const entry of archive.readable
      .pipeThrough(new DecompressionStream("gzip"))
      .pipeThrough(new UntarStream())
  ) {
    // Archive entries all live under a top-level "python/" directory.
    const rel = entry.path.replace(/^\.?\/?python\/?/, "");
    if (!rel || rel.includes("..")) {
      await entry.readable?.cancel();
      continue;
    }
    const target = `${staging}/${rel}`;
    const type = entry.header.typeflag;

    if (type === "5") {
      await Deno.mkdir(target, { recursive: true });
      continue;
    }
    await Deno.mkdir(dirname(target), { recursive: true });

    if (type === "2" || type === "1") {
      // Symlink / hardlink: python-build-standalone uses these for bin/python3
      // and the shared library.
      await entry.readable?.cancel();
      const link = entry.header.linkname;
      if (!link) continue;
      await Deno.remove(target).catch(() => {});
      try {
        if (type === "2") await Deno.symlink(link, target);
        else await Deno.link(`${staging}/${link.replace(/^\.?\/?python\/?/, "")}`, target);
      } catch (err) {
        log.debug("runtime.link", `link ${rel} -> ${link} skipped: ${err}`);
      }
      continue;
    }

    const file = await Deno.open(target, { create: true, write: true, truncate: true });
    await entry.readable!.pipeTo(file.writable);
    files++;

    // Preserve the executable bit (tar mode is octal); Windows has no chmod.
    if (Deno.build.os !== "windows") {
      const mode = Number(entry.header.mode ?? 0);
      if (mode & 0o111) await Deno.chmod(target, mode & 0o777).catch(() => {});
    }
  }

  await Deno.remove(paths.pythonDir, { recursive: true }).catch(() => {});
  await Deno.rename(staging, paths.pythonDir);
  await Deno.writeTextFile(`${paths.pythonDir}/${STAMP}`, BUNDLE_VERSION + "\n");

  log.info(
    "runtime.ready",
    `Python runtime ready (${files} files in ${
      ((performance.now() - started) / 1000).toFixed(1)
    }s)`,
  );
  return exe;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}
