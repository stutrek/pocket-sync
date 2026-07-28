/**
 * Build distributable apps for every platform.
 *
 *   deno task package               # host platform only
 *   deno task package --all         # every target
 *   deno task package --target x86_64-pc-windows-msvc
 *
 * Each build embeds a matching Python runtime (scripts/fetch_python.ts), so the
 * artifact a user downloads needs nothing installed except Calibre — and that
 * only for non-EPUB formats.
 *
 * `deno desktop` picks the packaging format from the --output extension. When a
 * format needs host tooling we don't have (a .dmg cannot be made off macOS),
 * the build falls back to the plain app directory and says so.
 */
import { buildRuntime, hostTarget, TARGETS, type TargetSpec } from "./fetch_python.ts";
import { ensureLocalNetworkUsage } from "./mac_localnet.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const DIST = `${ROOT}/dist`;
const RUNTIME = `${ROOT}/build/python-runtime.tar.gz`;

const PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-net",
  "--allow-run",
  "--allow-env",
  "--allow-sys",
  "--unstable-net",
  "--unstable-raw-imports",
];

interface Artifact {
  /** Preferred output filename; format comes from the extension. */
  installer: string;
  /** Plain output used when the installer format needs unavailable tooling. */
  plain: string;
  icon: string;
}

function artifacts(spec: TargetSpec): Artifact {
  const label = {
    "aarch64-apple-darwin": "macos-arm64",
    "x86_64-apple-darwin": "macos-x64",
    "x86_64-pc-windows-msvc": "windows-x64",
    "x86_64-unknown-linux-gnu": "linux-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
  }[spec.target] ?? spec.target;

  if (spec.target.includes("apple-darwin")) {
    return {
      installer: `PocketSync-${label}.dmg`,
      plain: `PocketSync-${label}.app`,
      icon: "assets/icon.png",
    };
  }
  if (spec.windows) {
    return {
      installer: `PocketSync-${label}.msi`,
      plain: `PocketSync-${label}`,
      icon: "assets/icon.ico",
    };
  }
  return {
    installer: `PocketSync-${label}.AppImage`,
    plain: `PocketSync-${label}`,
    icon: "assets/icon.png",
  };
}

async function build(spec: TargetSpec, output: string, icon: string): Promise<string | null> {
  // hdiutil (and friends) refuse to overwrite; clear the path first.
  await Deno.remove(`${DIST}/${output}`, { recursive: true }).catch(() => {});
  const args = [
    "desktop",
    ...PERMISSIONS,
    "--target",
    spec.target,
    "--include",
    "build/python-runtime.tar.gz",
    "--icon",
    icon,
    "--output",
    `dist/${output}`,
    "src/main.ts",
  ];
  const p = await new Deno.Command("deno", {
    args,
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (p.code === 0) return `${DIST}/${output}`;
  const err = new TextDecoder().decode(p.stderr).trim().split("\n").slice(-4).join("\n");
  console.log(`    ! ${output} failed:\n      ${err.replace(/\n/g, "\n      ")}`);
  return null;
}

/**
 * macOS is built in two steps rather than straight to a .dmg.
 *
 * `deno desktop` generates the Info.plist and seals the disk image in one go,
 * and the plist it writes has no `NSLocalNetworkUsageDescription` — which on
 * macOS 15+ means the app is denied LAN access silently and forever, with no
 * prompt and no entry under Privacy & Security (scripts/mac_localnet.ts). So:
 * build the plain bundle, declare the usage, then wrap it ourselves.
 */
async function buildMacos(
  spec: TargetSpec,
  installer: string,
  plain: string,
  icon: string,
): Promise<string | null> {
  const app = await build(spec, plain, icon);
  if (!app) return null;

  if (Deno.build.os === "darwin") {
    await ensureLocalNetworkUsage(app);
  } else {
    console.log(
      "    ! not on macOS: cannot declare local network access, the app will not " +
        "reach readers on the LAN",
    );
  }

  const dmg = `${DIST}/${installer}`;
  await Deno.remove(dmg).catch(() => {});
  const out = await new Deno.Command("hdiutil", {
    args: ["create", "-volname", "Pocket Sync", "-srcfolder", app, "-ov", "-format", "UDZO", dmg],
    stdout: "null",
    stderr: "piped",
  }).output().catch(() => null);
  if (!out?.success) {
    const err = out ? new TextDecoder().decode(out.stderr).trim().split("\n").pop() : "no hdiutil";
    console.log(`    ! ${installer} failed: ${err}`);
    console.log(`  · keeping ${plain}`);
    return app;
  }
  await Deno.remove(app, { recursive: true }).catch(() => {});
  return dmg;
}

async function size(path: string): Promise<string> {
  try {
    const out = await new Deno.Command("du", { args: ["-sh", path], stdout: "piped" }).output();
    return new TextDecoder().decode(out.stdout).split("\t")[0].trim();
  } catch {
    return "?";
  }
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  const targetArg = Deno.args[Deno.args.indexOf("--target") + 1];
  const specs = args.has("--all")
    ? TARGETS
    : TARGETS.filter((t) => t.target === (targetArg ?? hostTarget()));
  if (!specs.length) {
    console.error(`unknown target; known: ${TARGETS.map((t) => t.target).join(", ")}`);
    Deno.exit(1);
  }

  await Deno.mkdir(DIST, { recursive: true });

  // `deno desktop` embeds src/web/static/app.bundle.js as a text import, so the
  // UI must be bundled before any target is built. This shells out directly
  // rather than through a task, so the `ui` task dependency doesn't apply here.
  console.log("· bundling web UI");
  const ui = await new Deno.Command("deno", { args: ["task", "ui"], cwd: ROOT }).output();
  if (!ui.success) {
    console.error("failed to bundle the web UI");
    Deno.exit(1);
  }

  const results: { target: string; artifact: string; size: string }[] = [];

  for (const spec of specs) {
    console.log(`\n${spec.target}`);
    const runtime = await buildRuntime(spec, args.has("--force"));
    await Deno.copyFile(runtime, RUNTIME);

    const { installer, plain, icon } = artifacts(spec);
    console.log(`  · building ${installer}`);
    let built: string | null;
    if (spec.target.includes("apple-darwin")) {
      built = await buildMacos(spec, installer, plain, icon);
    } else {
      built = await build(spec, installer, icon);
      if (!built) {
        console.log(`  · retrying as ${plain}`);
        built = await build(spec, plain, icon);
      }
    }
    if (built) {
      // `deno desktop` leaves the intermediate app dir next to the installer;
      // dist/ should only hold things a user can download.
      if (built.endsWith(installer) && installer !== plain) {
        await Deno.remove(`${DIST}/${plain}`, { recursive: true }).catch(() => {});
      }
      const s = await size(built);
      console.log(`  ✓ ${built.replace(ROOT + "/", "")} (${s})`);
      results.push({
        target: spec.target,
        artifact: built.replace(`${DIST}/`, ""),
        size: s,
      });
    } else {
      results.push({ target: spec.target, artifact: "FAILED", size: "-" });
    }
  }

  console.log("\nArtifacts in dist/:");
  for (const r of results) {
    console.log(`  ${r.target.padEnd(26)} ${r.artifact.padEnd(34)} ${r.size}`);
  }
  if (results.some((r) => r.artifact === "FAILED")) Deno.exit(1);
}
