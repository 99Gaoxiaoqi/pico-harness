import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { toCanonicalUsage } from "@pico/core";
import { resolvePicoHome, resolvePicoPaths } from "@pico/pico-host";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import { globalSessionManager } from "@pico/pico-host/session";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigStore,
} from "@pico/pico-host/input/user-config-store";
import {
  createRuntimeRequest,
  isJsonObject,
  parseRuntimeResult,
  type RuntimeMethod,
  type RuntimeParams,
} from "@pico/protocol";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { loadUserDefaultRealModel } from "../real-llm-user-model.js";

export const GOAL_E2E_TIMEOUT_MS = 5 * 60_000;
const TOKEN_BUDGET = 150_000;
const SECRET_ENV = "PICO_GOAL_REAL_E2E_KEY";

interface GoalView {
  readonly id: string;
  readonly revision: number;
  readonly status: string;
  readonly iterations: number;
  readonly tokensAtStart: number;
  readonly tokensNow: number;
  readonly lastReason?: string;
}

/** Uses the production executor, AgentEngine and real Provider; only the external fixture changes. */
export async function createRealGoalHost(
  context: TestContext,
  options: { readonly releaseAfterContinuations?: number } = {},
) {
  const deadline = Date.now() + GOAL_E2E_TIMEOUT_MS - 20_000;
  const sourceHome = resolvePicoHome();
  const sourceConfig = (await new UserConfigStore({ picoHome: sourceHome }).read()).config;
  if (!sourceConfig.defaults?.modelRouteId) {
    context.skip("No user default real-model route is configured");
    return undefined;
  }
  const model = await loadUserDefaultRealModel({ picoHome: sourceHome }).catch((error: unknown) => {
    if (error instanceof Error && /缺少凭证环境变量/u.test(error.message)) return undefined;
    throw error;
  });
  if (!model) {
    context.skip("No credential is available for the user default real-model route");
    return undefined;
  }

  const root = await mkdtemp(join(tmpdir(), "pico-goal-real-host-"));
  const picoHome = join(root, "home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspacePath = await realpath(workspaceSeed);
  const markerPath = join(workspacePath, "external-build-status.txt");
  await writeFile(markerPath, "PENDING: the external build has not finished.\n", "utf8");
  const userConfigStore = new UserConfigStore({ picoHome });
  await userConfigStore.write(
    {
      version: 1,
      defaults: {
        modelRouteId: model.route.id,
        collaborationMode: "agent",
        permissionMode: "full-access",
        orchestrationMode: "default",
      },
      providers: {
        [model.route.providerId]: {
          protocol: model.provider,
          baseURL: model.config.baseURL,
          apiKeyEnv: SECRET_ENV,
          ...(model.route.auth ? { auth: model.route.auth } : {}),
          models: [model.route.model],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: EMPTY_USER_CONFIG_REVISION },
  );
  // Credentials stay in process memory; the temporary config contains only the environment name.
  if (model.config.apiKey) {
    assert.equal(
      (await readFile(userConfigStore.filePath, "utf8")).includes(model.config.apiKey),
      false,
      "the temporary config must not persist the real model credential",
    );
  }
  const services = createProductionRuntimeServices({
    env: { ...process.env, PICO_HOME: picoHome, [SECRET_ENV]: model.config.apiKey },
    userConfigStore,
  });
  const request = async <Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ) =>
    parseRuntimeResult(
      method,
      await services.desktopService.handle(createRuntimeRequest(method, params)),
    );
  const startedRuns = new Map<string, string>();
  const finishedRuns = new Map<string, string>();
  const continuationRunIds = new Set<string>();
  let sessionId = "";
  let markerReleased = false;
  let observerError: unknown;
  const unsubscribe = services.desktopService.subscribe((event) => {
    if (event.scope.sessionId !== sessionId || !event.scope.runId) return;
    const run = isJsonObject(event.payload) ? event.payload["run"] : undefined;
    if (!isJsonObject(run)) return;
    if (event.topic === "run.started") {
      const description = String(run["description"] ?? "");
      startedRuns.set(event.scope.runId, description);
      if (description.includes("Goal continuation")) continuationRunIds.add(event.scope.runId);
      if (
        !markerReleased &&
        options.releaseAfterContinuations !== undefined &&
        continuationRunIds.size >= options.releaseAfterContinuations
      ) {
        try {
          // Publish the external fixture before the newly admitted executor reads it.
          writeFileSync(markerPath, "READY: external build verified successfully.\n", "utf8");
          markerReleased = true;
        } catch (error) {
          observerError = error;
        }
      }
    } else if (event.topic === "run.finished") {
      finishedRuns.set(event.scope.runId, String(run["status"]));
    }
  });
  context.after(async () => {
    unsubscribe();
    try {
      await services.desktopService.close();
    } finally {
      if (sessionId)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  await services.trustStore.trust(workspacePath);
  await request("workspace.register", { workspacePath });
  sessionId = (await request("session.create", { workspacePath })).session.sessionId;
  const sessionScope = { workspacePath, sessionId };
  const settings = await request("session.settings.get", sessionScope);
  if (settings.settings.reasoningLevels.includes("off")) {
    await request("session.settings.update", { ...sessionScope, thinkingEffort: "off" });
  }
  const condition = `本轮必须重新用工具读取外部构建结果文件 ${markerPath}，读取结果包含 READY，且助手明确报告该读取结果时才完成。文件由外部系统更新，PENDING 表示尚未完成，需要等待后再次读取；不得自行修改、创建或删除此文件。`;
  const goal = async (): Promise<GoalView | undefined> => {
    const response = await request("goal.get", sessionScope);
    return response.goal?.currentGoal ?? undefined;
  };
  const assertRealExecutionAndReport = async (settled: GoalView) => {
    const storageRoot = resolvePicoPaths(workspacePath, { picoHome }).workspace.root;
    const eventsStore = new SqliteRuntimeEventStore({ storageRoot });
    const ledger = new SqliteRuntimeControlStore({ storageRoot });
    try {
      const events = await eventsStore.readSession(sessionId);
      const runStarts = events.filter((event) => event.kind === "run.started");
      const terminalRuns = events.filter((event) => event.kind === "run.terminal");
      const attempts = ledger.listPhysicalAttempts({ sessionId });
      const succeeded = attempts.filter((attempt) => attempt.status === "succeeded");
      const tokens = (purpose?: string) =>
        attempts
          .filter((attempt) => purpose === undefined || attempt.purpose === purpose)
          .reduce((sum, attempt) => {
            if (!attempt.usage) return sum;
            const usage = toCanonicalUsage(attempt.usage);
            return sum + usage.totalPromptTokens + usage.totalCompletionTokens;
          }, 0);
      context.diagnostic(
        JSON.stringify({
          modelRoute: model.route.id,
          status: settled.status,
          hostRuns: startedRuns.size,
          hostContinuations: continuationRunIds.size,
          iterations: settled.iterations,
          physicalAttempts: attempts.length,
          succeededEvaluations: succeeded.filter((attempt) => attempt.purpose === "goal_evaluation")
            .length,
          workTokens: tokens("main"),
          evaluatorTokens: tokens("goal_evaluation"),
          goalTokens: settled.tokensNow - settled.tokensAtStart,
          totalTokens: tokens(),
          knownCostCNY: attempts.reduce((sum, attempt) => sum + (attempt.costCNY ?? 0), 0),
          unknownCostCalls: attempts.filter((attempt) => attempt.costStatus === "unknown").length,
        }),
      );
      assert.equal(runStarts.length, startedRuns.size);
      assert.equal(terminalRuns.length, runStarts.length);
      assert.equal(new Set(runStarts.map((event) => event.runId)).size, runStarts.length);
      for (const run of runStarts) {
        assert.ok(
          events.some(
            (event) =>
              event.runId === run.runId &&
              event.kind === "tool.result.recorded" &&
              event.data.toolName === "read_file" &&
              event.data.status === "succeeded" &&
              /PENDING|READY/u.test(event.data.projection.text),
          ),
          `Run ${run.runId} must obtain actual marker file evidence`,
        );
        for (const purpose of ["main", "goal_evaluation"]) {
          assert.ok(
            succeeded.some((attempt) => attempt.runId === run.runId && attempt.purpose === purpose),
            `Run ${run.runId} must contain a real successful ${purpose} Provider call`,
          );
        }
      }
      assert.ok(tokens("main") > 0);
      assert.ok(tokens("goal_evaluation") > 0);
      const lastRunId = runStarts.at(-1)?.runId;
      assert.ok(
        events.some(
          (event) =>
            event.runId === lastRunId &&
            event.kind === "tool.result.recorded" &&
            event.data.toolName === "read_file" &&
            event.data.status === "succeeded" &&
            event.data.projection.text.includes(
              settled.status === "achieved" ? "READY" : "PENDING",
            ),
        ),
        "the terminal decision must agree with the last Run's real file evidence",
      );
    } finally {
      ledger.close();
      eventsStore.close();
    }
  };
  return {
    markerPath,
    startedRuns,
    continuationRunIds,
    goal,
    assertRealExecutionAndReport,
    async assertNoFurtherRuns() {
      const expectedRuns = startedRuns.size;
      const quietUntil = Date.now() + 5_500;
      while (Date.now() < quietUntil) {
        await delay(100, undefined, { signal: context.signal });
        assert.equal(startedRuns.size, expectedRuns, "terminal Goal must not admit another Run");
      }
    },
    async arm(maxIterations: number) {
      await request("goal.control", {
        ...sessionScope,
        action: "arm",
        expectedRevision: (await goal())?.revision ?? 0,
        condition,
        maxIterations,
        tokenBudget: TOKEN_BUDGET,
      });
    },
    async sendInitialInput() {
      await request("session.send", {
        ...sessionScope,
        idempotencyKey: "goal-real-e2e-initial-input",
        input: {
          kind: "text",
          text: `开始执行当前 Goal。每个 Run 只调用一次 read_file 读取 ${markerPath}，据实引用文件中的状态后结束本轮回复。若状态为 PENDING，明确说明等待外部构建完成；不要循环轮询、sleep、请求用户输入或操作 Goal 控制。Host 会自动续跑。若为 READY，报告实际读取到的构建成功证据。只读此文件，不执行其他任务。`,
        },
      });
    },
    async waitForTerminalGoal(): Promise<GoalView> {
      for (;;) {
        context.signal.throwIfAborted();
        if (observerError) throw observerError;
        const current = await goal();
        if (
          current &&
          !["active", "waiting"].includes(current.status) &&
          finishedRuns.size === startedRuns.size &&
          startedRuns.size > 0
        ) {
          assert.ok(
            [...finishedRuns.values()].every((status) => status === "succeeded"),
            `Host Runs must succeed: ${JSON.stringify([...finishedRuns])}`,
          );
          return current;
        }
        assert.ok(
          Date.now() < deadline,
          `Goal did not settle before deadline: ${current?.status}; ${current?.lastReason ?? ""}; Runs=${startedRuns.size}`,
        );
        await delay(100, undefined, { signal: context.signal });
      }
    },
  };
}
