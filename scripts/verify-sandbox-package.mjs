import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pico-sandbox-package-"));

try {
  const packOutput = run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--silent", "--pack-destination", temporaryRoot],
    projectRoot,
  );
  const archiveName = packOutput.trim().split(/\r?\n/u).at(-1);
  if (!archiveName) throw new Error("npm pack 未返回归档文件名");
  const archive = join(temporaryRoot, basename(archiveName));
  const unpackedRoot = join(temporaryRoot, "unpacked");
  await mkdir(unpackedRoot);
  run("tar", ["-xzf", archive, "-C", unpackedRoot], projectRoot);

  const packageRoot = join(unpackedRoot, "package");
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "resources/sandbox/manifest.json"), "utf8"),
  );
  const requiredExecutables = [
    ...manifest.linux.architectures.map((arch) => `resources/sandbox/linux-${arch}/bwrap`),
    `resources/sandbox/win32-x64/${manifest.windows.broker}`,
  ];
  for (const relativeExecutable of requiredExecutables) {
    const executable = join(packageRoot, relativeExecutable);
    await access(executable);
    if (relativeExecutable.includes("/linux-")) await access(executable, constants.X_OK);
    await verifySidecarDigest(executable);
  }

  const sourceArchive = join(
    packageRoot,
    "resources/licenses/bubblewrap",
    `bubblewrap-${manifest.linux.bubblewrapVersion}.tar.xz`,
  );
  const sourceDigest = await sha256(sourceArchive);
  if (sourceDigest !== manifest.linux.sourceSha256) {
    throw new Error(
      `Bubblewrap 对应源码校验失败: expected=${manifest.linux.sourceSha256} actual=${sourceDigest}`,
    );
  }
  const declaredSourceDigest = (
    await readFile(join(packageRoot, "resources/licenses/bubblewrap/SOURCE.sha256"), "utf8")
  )
    .trim()
    .split(/\s+/u)[0];
  if (declaredSourceDigest !== sourceDigest) {
    throw new Error("Bubblewrap 对应源码 sidecar 与归档内容不一致");
  }
  await access(join(packageRoot, "resources/licenses/bubblewrap/COPYING"));

  const packagedBackend = await import(
    pathToFileURL(join(packageRoot, "dist/safety/process-sandbox/backend.js")).href
  );
  for (const arch of manifest.linux.architectures) {
    const executable = packagedBackend.resolveBundledSandboxExecutable("linux", arch);
    if (!packagedBackend.isVerifiedBundledExecutable(executable, "linux")) {
      throw new Error(`打包后的 Linux 沙箱资源不可用: ${executable}`);
    }
  }
  const windowsExecutable = packagedBackend.resolveBundledSandboxExecutable("win32", "x64");
  if (!packagedBackend.isVerifiedBundledExecutable(windowsExecutable, "win32")) {
    throw new Error(`打包后的 Windows 沙箱资源不可用: ${windowsExecutable}`);
  }

  if (process.platform === "linux" && manifest.linux.architectures.includes(process.arch)) {
    const executable = join(packageRoot, `resources/sandbox/linux-${process.arch}/bwrap`);
    const version = run(executable, ["--version"], packageRoot);
    if (!version.includes(manifest.linux.bubblewrapVersion)) {
      throw new Error(`打包后的 Bubblewrap 版本不符: ${version.trim()}`);
    }
  }

  process.stdout.write(`Verified extracted sandbox package ${basename(archive)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifySidecarDigest(executable) {
  const expected = (await readFile(`${executable}.sha256`, "utf8")).trim().split(/\s+/u)[0];
  const actual = await sha256(executable);
  if (!expected || actual !== expected) {
    throw new Error(`打包后的沙箱原生资源校验失败: ${executable}`);
  }
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 失败 (${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}
