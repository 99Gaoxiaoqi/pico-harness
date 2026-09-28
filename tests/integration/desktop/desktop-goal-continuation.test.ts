import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "@pico/protocol";
import { GoalManager } from "@pico/runtime/goal-manager";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("Desktop arms a Goal for the next user Run and admits its continuation after settlement", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-goal-continuation-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const origins: Array<string | undefined> = [];
  let firstRunHeld = false;
  let notifyFirstRunStarted!: () => void;
  let releaseFirstRun!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    notifyFirstRunStarted = resolve;
  });
  const firstRunGate = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ sessionId, workspacePath: runWorkspace, execution }) => {
      origins.push(execution?.origin);
      if (!execution?.origin && !firstRunHeld) {
        firstRunHeld = true;
        notifyFirstRunStarted();
        await firstRunGate;
      }
      const lease = await globalSessionManager.getOrCreatePinned(sessionId!, runWorkspace, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        await lease.session.withSerializedExecution(async () => {
          const manager = new GoalManager();
          const unbind = lease.session.bindGoalManager(manager);
          try {
            manager.beginRun(execution?.origin === "goal" ? "goal" : "user");
            manager.settle(
              execution?.origin === "goal"
                ? {
                    outcome: "met",
                    progress: true,
                    reason: "CI 全绿",
                    evidence: ["CI run #42 passed"],
                  }
                : {
                    outcome: "progress",
                    progress: true,
                    reason: "已生成待验证构建",
                    evidence: ["构建产物已生成"],
                  },
            );
            manager.endRun();
            await lease.session.flushPersistence();
          } finally {
            unbind();
          }
        });
      } finally {
        lease.release();
      }
      return { ok: true };
    },
  });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const created = (await desktop.handle(
    createRuntimeRequest("session.create", { workspacePath }),
  )) as { session: { sessionId: string } };
  const sessionId = created.session.sessionId;
  await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath }));
  context.after(async () => {
    releaseFirstRun();
    await desktop.close();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  await desktop.handle(
    createRuntimeRequest("goal.control", {
      workspacePath,
      sessionId,
      action: "arm",
      title: "验证发布构建",
      description: "等待下一条普通用户消息后运行构建并验证 CI",
      completionCriteria: ["CI run is green"],
    }),
  );
  let goal = (await desktop.handle(
    createRuntimeRequest("goal.get", { workspacePath, sessionId }),
  )) as {
    goal: {
      readonly goals: readonly { readonly status: string; readonly awaitingUserTurn: boolean }[];
    };
  };
  assert.equal(goal.goal.goals[0]?.status, "active");
  assert.equal(goal.goal.goals[0]?.awaitingUserTurn, true);
  assert.deepEqual(origins, []);

  const firstRun = (await desktop.handle(
    createRuntimeRequest("session.send", {
      workspacePath,
      sessionId,
      input: { kind: "text", text: "现在开始验证" },
      idempotencyKey: "goal-e2e-user-input",
    }),
  )) as { readonly run: { readonly runId: string } };
  await firstRunStarted;
  const queued = (await desktop.handle(
    createRuntimeRequest("session.send", {
      workspacePath,
      sessionId,
      input: { kind: "text", text: "先检查这条用户补充" },
      behavior: "queue",
      expectedRunId: firstRun.run.runId,
      idempotencyKey: "goal-e2e-queued-user-input",
    }),
  )) as { readonly disposition: string };
  assert.equal(queued.disposition, "queued");
  releaseFirstRun();

  for (let attempt = 0; attempt < 250; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    goal = (await desktop.handle(
      createRuntimeRequest("goal.get", { workspacePath, sessionId }),
    )) as typeof goal;
    if (goal.goal.goals[0]?.status === "achieved") break;
  }
  assert.deepEqual(origins, [undefined, undefined, "goal"]);
  assert.equal(goal.goal.goals[0]?.status, "achieved");
  const runs = (await runtime.handle(
    createRuntimeRequest("runs.list", { workspacePath, sessionId }),
  )) as {
    readonly runs: readonly { readonly description: string }[];
  };
  assert.ok(runs.runs.some((run) => run.description.includes("Goal continuation · 验证发布构建")));
});

test("Desktop restart reconciles a terminal Goal Run by identity and pauses when it is missing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-goal-recovery-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const workspacePath = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const makeRuntime = () =>
    new WorkspaceRuntimeService({
      env,
      execute: async () => ({ ok: true }),
    });
  let runtime = makeRuntime();
  let desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  const created = (await desktop.handle(
    createRuntimeRequest("session.create", { workspacePath }),
  )) as { session: { sessionId: string } };
  const sessionId = created.session.sessionId;
  await desktop.handle(createRuntimeRequest("workspace.register", { workspacePath }));
  context.after(async () => {
    await desktop.close();
    await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });

  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const manager = new GoalManager();
  manager.create({
    title: "对账丢失的 Run",
    description: "恢复时不可重复执行未知身份的 Goal Run",
    completionCriteria: ["运行结果已核验"],
    awaitingUserTurn: true,
  });
  manager.beginRun("user", "missing-runtime-run");
  lease.session.updateRuntimeState({ goal: manager.snapshot() });
  await lease.session.flushPersistence();
  lease.release();

  await desktop.close();
  await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
  runtime = makeRuntime();
  desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  await (desktop as unknown as { goalRecoveryPromise: Promise<void> }).goalRecoveryPromise;

  let goal = (await desktop.handle(
    createRuntimeRequest("goal.get", { workspacePath, sessionId }),
  )) as { goal: { goals: readonly { status: string; blockedReason?: string }[] } };
  for (let attempt = 0; attempt < 100 && goal.goal.goals[0]?.status !== "paused"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    goal = (await desktop.handle(
      createRuntimeRequest("goal.get", { workspacePath, sessionId }),
    )) as typeof goal;
  }
  assert.equal(goal.goal.goals[0]?.status, "paused");
  assert.match(goal.goal.goals[0]?.blockedReason ?? "", /Runtime ledger 中不存在/u);
});
