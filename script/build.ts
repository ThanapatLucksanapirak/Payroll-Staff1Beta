import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = ["express", "zod", "papaparse"];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    // The face check runs in a worker thread (server/faceCheck.ts), which needs its own file: dist/faceWorker.cjs
    entryPoints: { index: "server/index.ts", faceWorker: "server/faceWorker.ts" },
    platform: "node",
    bundle: true,
    format: "cjs",
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Every file the app needs, with its checksum. The updater (deploy/payroll) checks
  // a new release against this list before switching to it, so a build that was cut
  // short (say, missing faceWorker.cjs) is never started.
  for (const need of REQUIRED) {
    if (!(await readFile(need).then(() => true, () => false))) throw new Error(`build is missing ${need}`);
  }
  const lines: string[] = [];
  for (const file of await listFiles("dist")) {
    lines.push(`${createHash("sha256").update(await readFile(file)).digest("hex")}  ${file.split(path.sep).join("/")}`);
  }
  await writeFile(path.join("dist", "SHA256SUMS"), lines.join("\n") + "\n");
  console.log(`wrote dist/SHA256SUMS (${lines.length} files)`);
}

/** Files without which the app can't run (the updater also checks these). */
const REQUIRED = ["dist/index.cjs", "dist/faceWorker.cjs", "dist/public/index.html"];

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile() && e.name !== "SHA256SUMS") out.push(p);
  }
  return out.sort();
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
