import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GrepTool,
  resetRgCache,
  setRgAvailable,
  type GrepDiagnostics,
} from "@pico/pico-host/grep-tool";
import { managedProcessLauncher } from "@pico/pico-host/process-sandbox";

/**
 * PATH 中残留的不可执行 rg 不能被当成可用引擎：
 * 旧实现只 stat 候选文件（Windows 上 X_OK 等价于存在性检查），spawn 时才以 ENOENT
 * 暴露；danger-full-access 下又因存在 sandbox 描述符而 fail closed，整个 grep 工具
 * 失效。修复后候选必须真实执行 `--version`，失败则跳过并降级到 Node.js。
 */
test("grep 跳过 PATH 中不可执行的 rg 候选并降级到 Node.js", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grep-rg-fallback-"));
  const workspace = join(root, "workspace");
  const fakeBin = join(root, "fake-bin");
  await mkdir(workspace);
  await mkdir(fakeBin);
  // 同名目录能通过存在性检查，但无法被 spawn 成进程。
  await mkdir(join(fakeBin, process.platform === "win32" ? "rg.exe" : "rg"));
  await writeFile(join(workspace, "needle.txt"), "fallback-needle\n", "utf8");

  const originalPath = process.env.PATH;
  process.env.PATH = fakeBin;
  context.after(async () => {
    process.env.PATH = originalPath;
    resetRgCache();
    await rm(root, { recursive: true, force: true });
  });
  resetRgCache();

  const warnings: string[] = [];
  const diagnostics: GrepDiagnostics = {
    warn: (_bindings, message) => warnings.push(message),
    debug: () => undefined,
  };
  const grep = new GrepTool(workspace, {
    diagnostics,
    processSandbox: { profile: "danger-full-access" },
  });

  const output = await grep.execute(JSON.stringify({ pattern: "fallback-needle" }));
  assert.match(output, /needle\.txt:1:fallback-needle/u);
  assert.deepEqual(warnings, [], "不可执行的候选应在探测阶段被跳过，而不是留到 spawn 才失败");
});

test("rg spawn 失败时只有真实 OS 沙箱 fail closed，danger-full-access 降级到 Node.js", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grep-rg-spawn-failure-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "needle.txt"), "spawn-failure-needle\n", "utf8");
  context.after(async () => {
    resetRgCache();
    await rm(root, { recursive: true, force: true });
  });
  resetRgCache();
  await setRgAvailable(true);
  context.mock.method(managedProcessLauncher, "launch", () => {
    throw new Error("rg spawn exploded");
  });

  const warnings: string[] = [];
  const diagnostics: GrepDiagnostics = {
    warn: (_bindings, message) => warnings.push(message),
    debug: () => undefined,
  };
  const unrestricted = new GrepTool(workspace, {
    diagnostics,
    processSandbox: { profile: "danger-full-access" },
  });
  assert.match(
    await unrestricted.execute(JSON.stringify({ pattern: "spawn-failure-needle" })),
    /needle\.txt:1:spawn-failure-needle/u,
  );
  assert.equal(warnings.length, 1, "降级路径必须留痕");
});

test("受限沙箱缺少可用 rg 时 fail closed，不退化到宿主 Node.js 读取", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-grep-rg-sandbox-missing-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "needle.txt"), "sandbox-no-rg-needle\n", "utf8");
  context.after(async () => {
    resetRgCache();
    await rm(root, { recursive: true, force: true });
  });
  resetRgCache();
  // 探测同样走 managedProcessLauncher；launch 失败即表示没有可验证的 rg。
  context.mock.method(managedProcessLauncher, "launch", () => {
    throw new Error("rg launch unavailable");
  });

  const grep = new GrepTool(workspace, { processSandbox: { profile: "read-only" } });
  await assert.rejects(
    grep.execute(JSON.stringify({ pattern: "sandbox-no-rg-needle" })),
    /没有可执行的 ripgrep/u,
  );
});
