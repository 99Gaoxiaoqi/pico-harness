import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodeIntelligenceManager } from "../../src/code-intelligence/index.js";
import { Session } from "../../src/engine/session.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";

test("SessionRuntime reaches a terminal released state after owned cleanup fails", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-session-runtime-dispose-"));
  const session = new Session("runtime-dispose-retry", workDir, { persistence: false });
  let releases = 0;
  const runtime = await createSessionRuntime({
    session,
    sessionLease: {
      session,
      release: () => {
        releases++;
      },
    },
    hooks: false,
    lspServers: [],
  });
  context.after(async () => {
    await runtime.dispose().catch(() => undefined);
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  });
  const originalClose = runtime.codeIntelligenceManager.close.bind(runtime.codeIntelligenceManager);
  let closes = 0;
  runtime.codeIntelligenceManager.close = async () => {
    closes++;
    if (closes === 1) throw new Error("fixture close failure");
    await originalClose();
  };

  await assert.rejects(runtime.dispose(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors.map(String).join("\n"), /fixture close failure/u);
    return true;
  });
  assert.equal(releases, 1);
  assert.equal(runtime.hookRewakeQueue.enqueue("closed after terminal dispose"), false);
  await assert.rejects(runtime.dispose(), /cleanup failed/u);
  assert.equal(closes, 1);
  assert.equal(releases, 1);
});

test("SessionRuntime code intelligence policy remains disabled until an Agent Run restores it", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-session-runtime-code-isolation-"));
  const session = new Session("runtime-code-isolation", workDir, { persistence: false });
  const runtime = await createSessionRuntime({
    session,
    sessionLease: { session, release: () => undefined },
    hooks: false,
    lspServers: [],
  });
  context.after(async () => {
    await runtime.dispose();
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  });
  const manager = runtime.codeIntelligenceManager;
  const originalClose = manager.close.bind(manager);
  const originalStart = manager.start.bind(manager);
  let closes = 0;
  let starts = 0;
  manager.close = async () => {
    closes++;
    await originalClose();
  };
  manager.start = async () => {
    starts++;
    return await originalStart();
  };

  await runtime.setCodeIntelligenceEnabled(false);
  await runtime.setCodeIntelligenceEnabled(false);
  assert.equal(closes, 1);
  assert.equal(starts, 1);
  assert.match(runtime.codeIntelligenceManager.status().reason, /运行时策略禁用/u);
  assert.equal(runtime.codeIntelligence.backend, "repo-map");
  await runtime.setCodeIntelligenceEnabled(true);
  await runtime.setCodeIntelligenceEnabled(true);
  assert.equal(closes, 2);
  assert.equal(starts, 2);
  assert.equal(runtime.codeIntelligence.backend, "repo-map");
});

test("disabled LSP policy skips configured process discovery and spawn", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-disabled-lsp-"));
  const spawnedMarker = join(workDir, "lsp-spawned");
  context.after(() => rm(workDir, { recursive: true, force: true }));
  const manager = new CodeIntelligenceManager({
    rootDir: workDir,
    lspEnabled: false,
    lspServers: [
      {
        id: "must-not-spawn",
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "spawned")`,
        ],
        startupTimeoutMs: 100,
      },
    ],
  });
  context.after(() => manager.close());

  const status = await manager.start();
  assert.equal(status.backend, "repo-map");
  assert.match(status.reason, /运行时策略禁用/u);
  assert.equal(manager.lspClient(), undefined);
  await assert.rejects(access(spawnedMarker));
});

test("persisted Plan collaboration disables LSP before SessionRuntime startup", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-persisted-plan-lsp-"));
  const spawnedMarker = join(workDir, "lsp-spawned");
  const session = new Session("persisted-plan-lsp", workDir, { persistence: false });
  session.updateRuntimeState({
    settings: {
      provider: "openai",
      model: "test",
      modelRouteId: "test/test",
      collaborationMode: "plan",
      permissionMode: "auto",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
  });
  const runtime = await createSessionRuntime({
    session,
    sessionLease: { session, release: () => undefined },
    hooks: false,
    lspServers: [
      {
        id: "must-not-spawn",
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(spawnedMarker)}, "spawned")`,
        ],
        startupTimeoutMs: 100,
      },
    ],
  });
  context.after(async () => {
    await runtime.dispose();
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  });

  assert.match(runtime.codeIntelligenceManager.status().reason, /运行时策略禁用/u);
  await assert.rejects(access(spawnedMarker));
  await runtime.setCodeIntelligenceEnabled(true);
  // LSP 始终使用 read-only profile：启动已尝试，但测试 server 不得写 marker。
  await assert.rejects(access(spawnedMarker));
  assert.match(runtime.codeIntelligenceManager.status().reason, /启动失败/u);
});
