/**
 * Build-time: assemble a self-contained Python runtime (CPython + Pillow +
 * lxml) for one target and write it to `build/python-<target>.tar.gz`.
 *
 * The archive is embedded into the app with `deno desktop --include` and
 * unpacked on first run, so a downloaded app needs no Python, no pip and no
 * setup script. See src/engine/runtime.ts for the runtime half.
 *
 *   deno run -A scripts/fetch_python.ts --target aarch64-apple-darwin
 *   deno run -A scripts/fetch_python.ts --all
 */

const CPYTHON_RELEASE = "20260718";
const CPYTHON_VERSION = "3.12.13";
const PY_TAG = "cp312";
const PY_VERSION_SHORT = "3.12";

export interface TargetSpec {
  /** Deno --target triple. */
  target: string;
  /** python-build-standalone triple. */
  python: string;
  /** pip platform tags, most specific first. */
  wheelTags: string[];
  windows?: boolean;
}

export const TARGETS: TargetSpec[] = [
  {
    target: "aarch64-apple-darwin",
    python: "aarch64-apple-darwin",
    wheelTags: ["macosx_11_0_arm64"],
  },
  {
    target: "x86_64-apple-darwin",
    python: "x86_64-apple-darwin",
    wheelTags: ["macosx_10_13_x86_64", "macosx_10_15_x86_64", "macosx_11_0_x86_64"],
  },
  {
    target: "x86_64-pc-windows-msvc",
    python: "x86_64-pc-windows-msvc",
    wheelTags: ["win_amd64"],
    windows: true,
  },
  {
    target: "x86_64-unknown-linux-gnu",
    python: "x86_64-unknown-linux-gnu",
    wheelTags: ["manylinux_2_28_x86_64", "manylinux2014_x86_64"],
  },
  {
    target: "aarch64-unknown-linux-gnu",
    python: "aarch64-unknown-linux-gnu",
    wheelTags: ["manylinux_2_28_aarch64", "manylinux2014_aarch64"],
  },
];

/** Stripped to keep the download small — none of it is used by the optimizer. */
const PRUNE = [
  "lib/python3.12/test",
  "lib/python3.12/idlelib",
  "lib/python3.12/tkinter",
  "lib/python3.12/lib2to3",
  "lib/python3.12/ensurepip",
  "lib/python3.12/config-3.12-darwin",
  "lib/python3.12/distutils/tests",
  "lib/python3.12/unittest/test",
  "share",
  "include",
  "Lib/test",
  "Lib/idlelib",
  "Lib/tkinter",
  "Lib/lib2to3",
  "Lib/ensurepip",
  "tcl",
  "tcl9",
  "tcl9.0",
  "tk9.0",
  "itcl4.3.5",
  "Tools",
  "Doc",
  "libs",
];

/** Extra dead weight matched by pattern rather than exact path. */
const PRUNE_PATTERNS: RegExp[] = [
  /\.a$/, // static libpython (~50 MB on Linux)
  /\.pdb$/, // Windows debug symbols
  /\/config-3\.12-[^/]+$/, // build config dirs, dropped as a whole
  /\/(test|tests)$/,
];

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const BUILD = `${ROOT}/build`;

async function sh(cmd: string, args: string[], cwd?: string) {
  const p = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (p.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${p.code}):\n${new TextDecoder().decode(p.stderr)}`,
    );
  }
  return new TextDecoder().decode(p.stdout);
}

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Host python used only to drive `pip download` — any 3.x will do. */
function hostPython(): string {
  return Deno.env.get("PYTHON") ?? "python3";
}

async function du(path: string): Promise<string> {
  try {
    return (await sh("du", ["-sh", path])).split("\t")[0].trim();
  } catch {
    return "?";
  }
}

export async function buildRuntime(spec: TargetSpec, force = false): Promise<string> {
  const out = `${BUILD}/python-${spec.target}.tar.gz`;
  if (!force && await exists(out)) {
    console.log(`  ✓ ${spec.target}: cached (${await du(out)})`);
    return out;
  }

  const work = `${BUILD}/work/${spec.target}`;
  await Deno.mkdir(work, { recursive: true });
  await Deno.mkdir(BUILD, { recursive: true });

  // 1. portable CPython
  // "install_only_stripped" drops debug symbols — on Linux that is the
  // difference between a 209 MB libpython and a few MB.
  const asset =
    `cpython-${CPYTHON_VERSION}+${CPYTHON_RELEASE}-${spec.python}-install_only_stripped.tar.gz`;
  const url =
    `https://github.com/astral-sh/python-build-standalone/releases/download/${CPYTHON_RELEASE}/${asset}`;
  const tarball = `${BUILD}/cache/${asset}`;
  await Deno.mkdir(`${BUILD}/cache`, { recursive: true });
  if (!await exists(tarball)) {
    console.log(`  ↓ ${asset}`);
    await sh("curl", ["-fsSL", url, "-o", tarball]);
  }

  await Deno.remove(`${work}/python`, { recursive: true }).catch(() => {});
  await sh("tar", ["xzf", tarball, "-C", work]);

  // 2. Pillow + lxml wheels for the *target* platform
  const site = spec.windows
    ? `${work}/python/Lib/site-packages`
    : `${work}/python/lib/python${PY_VERSION_SHORT}/site-packages`;
  await Deno.mkdir(site, { recursive: true });
  const pipArgs = [
    "-m",
    "pip",
    "install",
    "--quiet",
    "--target",
    site,
    "--no-deps",
    "--only-binary=:all:",
    "--python-version",
    PY_VERSION_SHORT,
    "--implementation",
    "cp",
    "--abi",
    PY_TAG,
    ...spec.wheelTags.flatMap((t) => ["--platform", t]),
    "Pillow",
    "lxml",
  ];
  console.log(`  · installing Pillow + lxml (${spec.wheelTags[0]})`);
  await sh(hostPython(), pipArgs);

  // 3. prune, then repack
  for (const rel of PRUNE) {
    await Deno.remove(`${work}/python/${rel}`, { recursive: true }).catch(() => {});
  }
  for await (const path of walkPrunable(`${work}/python`)) {
    await Deno.remove(path, { recursive: true }).catch(() => {});
  }

  await sh("tar", ["czf", out, "-C", work, "python"]);
  await Deno.remove(work, { recursive: true }).catch(() => {});
  console.log(`  ✓ ${spec.target}: ${await du(out)}`);
  return out;
}

async function* walkPrunable(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (PRUNE_PATTERNS.some((re) => re.test(path))) {
      yield path;
      continue;
    }
    if (!entry.isDirectory) continue;
    if (entry.name === "__pycache__" || entry.name.endsWith(".dist-info")) {
      yield path;
      continue;
    }
    yield* walkPrunable(path);
  }
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  const force = args.has("--force");
  const targetArg = Deno.args[Deno.args.indexOf("--target") + 1];
  const specs = args.has("--all")
    ? TARGETS
    : TARGETS.filter((t) => t.target === (targetArg ?? hostTarget()));
  if (!specs.length) {
    console.error(`unknown target; known: ${TARGETS.map((t) => t.target).join(", ")}`);
    Deno.exit(1);
  }
  console.log(`Building Python runtimes (CPython ${CPYTHON_VERSION}):`);
  for (const spec of specs) await buildRuntime(spec, force);
}

export function hostTarget(): string {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  switch (Deno.build.os) {
    case "darwin":
      return `${arch}-apple-darwin`;
    case "windows":
      return `${arch}-pc-windows-msvc`;
    default:
      return `${arch}-unknown-linux-gnu`;
  }
}
