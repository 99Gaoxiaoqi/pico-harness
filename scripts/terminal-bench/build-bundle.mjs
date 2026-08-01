import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const xattrHelperDigests = {
  arm64: "141664b015f756b10fd76c9f92c83052bbb721f2c88d368349ec1e5c619e72a2",
  x64: "ee31a4ebd31823a4f29d338225dc8c12b4fb4939e200b797ab5ce2b0aa9c7056",
};

export async function buildPicoBundle(outputPath) {
  const destination = resolve(outputPath);
  const stage = `${destination}.stage`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(join(stage, "packages/protocol"), { recursive: true });
  const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const protocolPackage = JSON.parse(
    await readFile(join(projectRoot, "packages/protocol/package.json"), "utf8"),
  );
  const packageJson = {
    name: "pico-headless-benchmark-bundle",
    version: rootPackage.version,
    private: true,
    type: "module",
    dependencies: {
      ...rootPackage.dependencies,
      "@pico/protocol": "file:packages/protocol",
    },
  };
  await cp(join(projectRoot, "dist"), join(stage, "dist"), { recursive: true });
  await cp(join(projectRoot, "packages/protocol/dist"), join(stage, "packages/protocol/dist"), {
    recursive: true,
  });
  await cp(
    join(projectRoot, "scripts/terminal-bench/container-launcher.mjs"),
    join(stage, "container-launcher.mjs"),
  );
  await copyVerifiedXattrHelpers(stage);
  await writeFile(join(stage, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(
    join(stage, "packages/protocol/package.json"),
    `${JSON.stringify(
      {
        name: protocolPackage.name,
        version: protocolPackage.version,
        type: protocolPackage.type,
        main: protocolPackage.main,
        types: protocolPackage.types,
        exports: protocolPackage.exports,
      },
      null,
      2,
    )}\n`,
  );
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
  await rm(join(stage, "node_modules/@pico/protocol"), { recursive: true, force: true });
  await cp(join(stage, "packages/protocol"), join(stage, "node_modules/@pico/protocol"), {
    recursive: true,
  });
  await assertNoLinks(stage);
  await mkdir(dirname(destination), { recursive: true });
  await run("tar", ["-czf", destination, "-C", stage, "."], projectRoot);
  const digest = createHash("sha256")
    .update(await readFile(destination))
    .digest("hex");
  await rm(stage, { recursive: true, force: true });
  return { path: destination, sha256: digest, lockfileSha256 };
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
