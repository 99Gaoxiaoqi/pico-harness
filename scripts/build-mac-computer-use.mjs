import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("macOS Computer Use 只能在 macOS 构建");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native/mac-computer-use/main.swift");
const outputRoot = join(root, "resources/computer-use", `darwin-${process.arch}`);
await mkdir(outputRoot, { recursive: true });
const output = join(outputRoot, "pico-computer-use");
const built = spawnSync("xcrun", ["swiftc", "-O", source, "-o", output], {
  cwd: root,
  stdio: "inherit",
  shell: false,
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error(`macOS Computer Use 编译失败 (${built.status})`);
const digest = createHash("sha256")
  .update(await readFile(output))
  .digest("hex");
await writeFile(`${output}.sha256`, `${digest}  pico-computer-use\n`);
process.stdout.write(`Built macOS Computer Use for ${process.arch}: ${digest}\n`);
