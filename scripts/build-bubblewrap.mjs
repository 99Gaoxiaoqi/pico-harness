import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const manifest = JSON.parse(
  await readFile(join(projectRoot, "resources/sandbox/manifest.json"), "utf8"),
);
const linux = manifest.linux;
if (process.platform !== "linux") throw new Error("Bubblewrap 只能在目标 Linux 架构上构建");
if (!linux.architectures.includes(process.arch)) {
  throw new Error(`不支持的 Bubblewrap 架构: ${process.arch}`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "pico-bubblewrap-build-"));
const archive = join(temporaryRoot, `bubblewrap-${linux.bubblewrapVersion}.tar.xz`);
const response = await fetch(linux.sourceUrl, { redirect: "follow" });
if (!response.ok) throw new Error(`下载 Bubblewrap 失败: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== linux.sourceSha256) {
  throw new Error(`Bubblewrap 源码校验失败: expected=${linux.sourceSha256} actual=${digest}`);
}
await writeFile(archive, bytes, { mode: 0o600 });

run("tar", ["-xJf", archive, "-C", temporaryRoot]);
const sourceRoot = join(temporaryRoot, `bubblewrap-${linux.bubblewrapVersion}`);
const buildRoot = join(temporaryRoot, "build");
run("meson", [
  "setup",
  "--prefer-static",
  "-Dtests=false",
  "-Dman=disabled",
  "-Dbash_completion=disabled",
  "-Dzsh_completion=disabled",
  "-Dselinux=disabled",
  "-Dsupport_setuid=false",
  buildRoot,
  sourceRoot,
]);
run("meson", ["compile", "-C", buildRoot, "bwrap"]);

const outputRoot = join(projectRoot, `resources/sandbox/linux-${process.arch}`);
const licenseRoot = join(projectRoot, "resources/licenses/bubblewrap");
await mkdir(outputRoot, { recursive: true });
await mkdir(licenseRoot, { recursive: true });
const output = join(outputRoot, "bwrap");
await copyFile(join(buildRoot, "bwrap"), output);
await chmod(output, 0o755);
await copyFile(archive, join(licenseRoot, `bubblewrap-${linux.bubblewrapVersion}.tar.xz`));
await copyFile(join(sourceRoot, "COPYING"), join(licenseRoot, "COPYING"));
await writeFile(
  join(licenseRoot, "SOURCE.sha256"),
  `${linux.sourceSha256}  bubblewrap-${linux.bubblewrapVersion}.tar.xz\n`,
);

const binaryDigest = createHash("sha256")
  .update(await readFile(output))
  .digest("hex");
await writeFile(`${output}.sha256`, `${binaryDigest}  bwrap\n`);
const linkage = run("ldd", [output], true);
if (/libcap\.so/u.test(linkage)) {
  throw new Error("Bubblewrap 仍动态依赖 libcap，拒绝生成不可移植资源");
}
process.stdout.write(
  `Built verified Bubblewrap ${linux.bubblewrapVersion} for linux-${process.arch}\n`,
);

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 失败 (${result.status}): ${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}
