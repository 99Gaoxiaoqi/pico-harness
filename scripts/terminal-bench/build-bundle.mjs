import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const xattrHelperDigests = {
  arm64: "27657d44d82e89068282b38e4d625856a8511334ba75ba89c2e27bf8831f8e0b",
  x64: "8554508c77c2fc7909516150bbc40439d926f2de003faff6d02800e428802681",
};

export async function buildPicoBundle(outputPath) {
  const destination = resolve(outputPath);
  const stage = `${destination}.stage`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  const { packageJson, localPackages } = await createBundlePackagePlan();
  await cp(join(projectRoot, "dist"), join(stage, "dist"), { recursive: true });
  for (const local of localPackages) {
    const target = join(stage, local.path);
    await mkdir(target, { recursive: true });
    for (const artifact of local.artifacts) {
      await cp(join(projectRoot, local.path, artifact), join(target, artifact), {
        recursive: true,
      });
    }
    await writeFile(
      join(target, "package.json"),
      `${JSON.stringify(local.packageJson, null, 2)}\n`,
    );
  }
  await cp(
    join(projectRoot, "scripts/terminal-bench/container-launcher.mjs"),
    join(stage, "container-launcher.mjs"),
  );
  await copyVerifiedXattrHelpers(stage);
  await writeFile(join(stage, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const approvedLockfilePath = join(
    projectRoot,
    "benchmarks/terminal_bench_2_1/bundle-package-lock.json",
  );
  const approvedLockfile = await readFile(approvedLockfilePath);
  const approvedLockfileSha256 = (
    await readFile(
      join(projectRoot, "benchmarks/terminal_bench_2_1/bundle-lock-sha256.txt"),
      "utf8",
    )
  ).trim();
  if (createHash("sha256").update(approvedLockfile).digest("hex") !== approvedLockfileSha256) {
    throw new Error("Terminal-Bench approved bundle lock digest is invalid");
  }
  await writeFile(join(stage, "package-lock.json"), approvedLockfile);
  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  const lockfileSha256 = createHash("sha256")
    .update(await readFile(join(stage, "package-lock.json")))
    .digest("hex");
  if (lockfileSha256 !== approvedLockfileSha256) {
    throw new Error("Terminal-Bench bundle dependency lock is not pre-approved");
  }
  await rm(join(stage, "node_modules/.bin"), { recursive: true, force: true });
  // npm file dependencies are links. Materialize every workspace package before archiving.
  for (const local of localPackages) {
    const installed = join(stage, "node_modules", local.packageJson.name);
    await rm(installed, { recursive: true, force: true });
    await cp(join(stage, local.path), installed, { recursive: true });
  }
  await assertNoLinks(stage);
  await mkdir(dirname(destination), { recursive: true });
  await run("tar", ["-czf", destination, "-C", stage, "."], projectRoot);
  const digest = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
  await rm(stage, { recursive: true, force: true });
  return { path: destination, sha256: digest, lockfileSha256 };
}

/** The staged dependency graph is local and independent of unpublished workspace versions. */
export async function createBundlePackagePlan() {
  const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const available = new Map();
  for (const directory of await readdir(join(projectRoot, "packages"), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const path = `packages/${directory.name}`;
    const pkg = JSON.parse(await readFile(join(projectRoot, path, "package.json"), "utf8"));
    available.set(pkg.name, { path, pkg });
  }
  const selected = new Map();
  function localize(dependencies, parentPath = "") {
    return Object.fromEntries(
      Object.entries(dependencies).map(([name, version]) => {
        const local = available.get(name);
        if (!local) {
          if (name.startsWith("@pico/"))
            throw new Error(`Missing local benchmark dependency: ${name}`);
          return [name, version];
        }
        if (!selected.has(name)) {
          selected.set(name, local);
          for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
            localize(local.pkg[field] ?? {}, local.path);
          }
        }
        return [name, `file:${posix.relative(parentPath, local.path)}`];
      }),
    );
  }
  const packageJson = {
    name: "pico-headless-benchmark-bundle",
    version: rootPackage.version,
    private: true,
    type: "module",
    dependencies: localize(rootPackage.dependencies),
  };
  // Root file dependencies ensure npm resolves transitive workspaces without consulting a registry.
  for (const [name, local] of selected) packageJson.dependencies[name] = `file:${local.path}`;
  const localPackages = [];
  for (const local of [...selected.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const manifest = { ...local.pkg };
    delete manifest.scripts;
    delete manifest.devDependencies;
    delete manifest.workspaces;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest[field]) manifest[field] = localize(manifest[field], local.path);
    }
    const artifacts = ["dist"];
    for (const asset of ["resources", "assets"]) {
      try {
        if ((await lstat(join(projectRoot, local.path, asset))).isDirectory())
          artifacts.push(asset);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    localPackages.push({ path: local.path, packageJson: manifest, artifacts });
  }
  return { packageJson, localPackages };
}

async function copyVerifiedXattrHelpers(stage) {
  const sourceRoot = join(projectRoot, "scripts/terminal-bench/xattr-helper/bin");
  const destinationRoot = join(stage, "xattr-helper/bin");
  await mkdir(destinationRoot, { recursive: true });
  for (const [arch, digest] of Object.entries(xattrHelperDigests)) {
    const name = `xattr-helper-linux-${arch}`;
    const source = join(sourceRoot, name);
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error(`Terminal-Bench xattr helper digest is invalid: ${name}`);
    }
    await writeFile(join(destinationRoot, name), bytes, { mode: 0o755 });
  }
}

async function assertNoLinks(root) {
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Terminal-Bench bundle contains a symbolic link: ${path}`);
    }
    if (!info.isDirectory()) return;
    for (const entry of await readdir(path)) await visit(join(path, entry));
  }
  await visit(root);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error("Usage: build-bundle.mjs <output.tar.gz>");
  const result = await buildPicoBundle(output);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
