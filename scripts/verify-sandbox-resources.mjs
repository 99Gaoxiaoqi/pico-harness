import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(projectRoot, "resources/sandbox/manifest.json"), "utf8"),
);
if (manifest.version !== 1) throw new Error("不支持的沙箱资源 manifest 版本");
if (!/^\d+\.\d+\.\d+$/u.test(manifest.linux?.bubblewrapVersion ?? "")) {
  throw new Error("Bubblewrap 版本无效");
}
if (!/^[a-f0-9]{64}$/u.test(manifest.linux?.sourceSha256 ?? "")) {
  throw new Error("Bubblewrap 源码 SHA-256 无效");
}
if (manifest.windows?.broker !== "pico-appcontainer-broker.exe") {
  throw new Error("Windows AppContainer Broker manifest 无效");
}
for (const source of ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/windows.rs"]) {
  await access(join(projectRoot, "native/windows-appcontainer-broker", source));
}

const requiredExecutables = process.argv.includes("--require-all")
  ? [
      "resources/sandbox/linux-x64/bwrap",
      "resources/sandbox/linux-arm64/bwrap",
      "resources/sandbox/win32-x64/pico-appcontainer-broker.exe",
    ]
  : process.argv.includes("--require-current") && process.platform !== "darwin"
    ? [
        process.platform === "win32"
          ? `resources/sandbox/win32-${process.arch}/pico-appcontainer-broker.exe`
          : `resources/sandbox/linux-${process.arch}/bwrap`,
      ]
    : [];
for (const relativeExecutable of requiredExecutables) {
  const executable = join(projectRoot, relativeExecutable);
  await access(executable);
  const expected = (await readFile(`${executable}.sha256`, "utf8")).trim().split(/\s+/u)[0];
  const actual = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (actual !== expected) throw new Error(`沙箱原生资源校验失败: ${executable}`);
}
process.stdout.write("Sandbox resource manifest verified\n");
