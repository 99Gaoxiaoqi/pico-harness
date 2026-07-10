import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

const root = process.cwd();
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const relativeEntry = pkg.bin?.pico;
if (typeof relativeEntry !== "string") {
  fail("package.json 缺少 bin.pico");
}

const entry = join(root, relativeEntry);
await access(entry, constants.R_OK);
if (process.platform !== "win32") {
  await access(entry, constants.X_OK);
}

const source = await readFile(entry, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  fail(`${relativeEntry} 缺少 Node shebang`);
}

try {
  await access(join(root, "dist", "src"), constants.F_OK);
  fail("构建产物不应包含 dist/src 目录");
} catch (error) {
  if (error instanceof Error && error.message.includes("不应包含")) throw error;
}

const version = runEntry(["--version"]);
if (version.stdout.trim() !== pkg.version) {
  fail(`--version 输出不匹配: ${JSON.stringify(version.stdout)}`);
}

const help = runEntry(["--help"]);
if (!help.stdout.includes("Usage: pico [options]")) {
  fail("--help 未输出用法");
}

process.stdout.write(`package bin smoke passed: ${relativeEntry} (${pkg.version})\n`);

function runEntry(args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, LLM_BASE_URL: "", LLM_API_KEY: "", LLM_API_KEYS: "" },
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${relativeEntry} ${args.join(" ")} 退出码 ${String(result.status)}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function fail(message) {
  throw new Error(`package bin smoke failed: ${message}`);
}
