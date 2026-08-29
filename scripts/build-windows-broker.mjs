import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("AppContainer Broker 只能在 Windows x64 目标宿主构建");
}
const crateRoot = join(projectRoot, "native/windows-appcontainer-broker");
const target = "x86_64-pc-windows-msvc";
const result = spawnSync(
  "cargo",
  ["build", "--locked", "--release", "--bins", "--target", target],
  {
    cwd: crateRoot,
    stdio: "inherit",
    shell: false,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Rust Broker 构建失败 (${String(result.status)})`);

const outputRoot = join(projectRoot, "resources/sandbox/win32-x64");
await mkdir(outputRoot, { recursive: true });
for (const executable of ["pico-appcontainer-broker.exe", "pico-appcontainer-host-prep.exe"]) {
  const source = join(crateRoot, "target", target, "release", executable);
  const output = join(outputRoot, executable);
  await copyFile(source, output);
  const digest = createHash("sha256")
    .update(await readFile(output))
    .digest("hex");
  await writeFile(`${output}.sha256`, `${digest}  ${executable}\n`);
}
process.stdout.write("Built verified Pico Windows AppContainer resources for win32-x64\n");
