import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const fixture = await mkdtemp(join(tmpdir(), "pico-package-install-smoke-"));

try {
  const pack = run(
    npm,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
    root,
  );
  const packed = JSON.parse(pack.stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") fail(`npm pack 未返回 tarball 名称: ${pack.stdout}`);

  const consumer = join(fixture, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "pico-package-consumer", private: true }, null, 2)}\n`,
    "utf8",
  );
  run(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(fixture, filename)],
    consumer,
  );

  const installedRoot = join(consumer, "node_modules", "pico-harness");
  const installedPackage = JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"));
  const protocol = await import(
    pathToFileURL(join(installedRoot, "dist", "daemon", "protocol.js")).href
  );
  if (!Number.isInteger(protocol.LOCAL_RUNTIME_PROTOCOL_VERSION)) {
    fail("安装后无法从根发布物加载私有协议包");
  }

  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "pico.cmd" : "pico",
  );
  const version = run(bin, ["--version"], consumer);
  if (version.stdout.trim() !== installedPackage.version) {
    fail(`干净安装后 --version 输出不匹配: ${JSON.stringify(version.stdout)}`);
  }
  const help = run(bin, ["--help"], consumer);
  if (!help.stdout.includes("Usage: pico [options]")) {
    fail("干净安装后 --help 未输出用法");
  }

  process.stdout.write(
    `package clean install smoke passed: ${filename} (${installedPackage.version})\n`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LLM_BASE_URL: "", LLM_API_KEY: "", LLM_API_KEYS: "" },
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} 退出码 ${String(result.status)}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function fail(message) {
  throw new Error(`package clean install smoke failed: ${message}`);
}
