import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import { projectDiscoveryEntries } from "../../src/discovery/reducer.js";
import type { DiscoveryCheckpoint, DiscoveryProjection } from "../../src/discovery/contract.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import type { Message, ToolCall } from "../../src/schema/message.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import {
  createDiscoveryLargeRepoFixture,
  type DiscoveryLargeRepoFixture,
} from "../fixtures/discovery-large-repo.js";
import { configuredUserDefaultRealModel, type RealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

interface TestSandbox {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
}

interface ProviderSnapshot {
  readonly system: string;
  readonly tools: readonly string[];
}

interface RuntimeHostOptions {
  readonly maxTurns?: number;
  readonly beforeFirstModelCall?: () => Promise<void>;
}

realModelTest(
  "real discovery loop locates a late target, hands off a verified plan, and edits only after approval",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox();
    context.after(() => cleanupSandbox(sandbox));
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir);
    const beforePlanning = await workspaceHashes(sandbox.workDir);
    const providerSnapshots: ProviderSnapshot[] = [];
    const runtime = new AgentRuntime();

    const planned = await runtime.execute(
      {
        ...modelRequest(model),
        prompt: [
          `Read ${fixture.taskPath} first and investigate the requested behavior before planning.`,
          `Use repo_map with query=${JSON.stringify(fixture.targetSymbol)} and max_files=200.`,
          "The target is deliberately after the first scan batch: when complete=false and the symbol is absent, call repo_map again with the same query and max_files=200.",
          "After locating the symbol, read its exact implementation file and ground the plan in that evidence.",
          "Submit exactly one implementation step that changes only the confirmed target and verifies the returned canary by rereading it.",
          "Do not modify any file before approval. Finish by calling submit_plan exactly once.",
        ].join("\n"),
        dir: sandbox.workDir,
        sessionSelection: { mode: "new", sessionId: sandbox.sessionId },
        interactionMode: "plan",
        allowedTools: ["read_file", "read_evidence", "repo_map", "submit_plan"],
      },
      runtimeHost(sandbox, model, providerSnapshots),
    );

    const handoff = planned.handoff;
    assert.ok(handoff);
    assert.deepEqual(await workspaceHashes(sandbox.workDir), beforePlanning);
    const planningState = await readRuntimeState(sandbox);
    const planningEvents = planningState.events;
    assertClosedRuns(planningEvents, 1);
    assertMainModelSucceeded(planningEvents);
    assert.equal(toolCalls(planningEvents, "submit_plan").length, 1);

    const repoMapCalls = toolCalls(planningEvents, "repo_map");
    assert.ok(repoMapCalls.length >= 2, "late target requires at least two Repo Map batches");
    for (const call of repoMapCalls) {
      const input = parseArguments(call);
      assert.equal(input["query"], fixture.targetSymbol);
      assert.equal(input["max_files"], 200);
    }
    const repoMapOutputs = repoMapCalls.map((call) => successfulToolOutput(planningEvents, call));
    assert.match(repoMapOutputs[0] ?? "", /complete=false/u);
    assert.doesNotMatch(repoMapOutputs[0] ?? "", new RegExp(escapeRegExp(fixture.targetPath), "u"));
    assert.ok(
      repoMapOutputs.slice(1).some((output) => output.includes(fixture.targetPath)),
      "a later Repo Map batch must resolve the target path",
    );

    const targetRead = toolCalls(planningEvents, "read_file").find((call) =>
      sameWorkspacePath(sandbox.workDir, parseArguments(call)["path"], fixture.targetPath),
    );
    assert.ok(targetRead, "planning must read the exact target after locating it");
    assert.equal(successfulToolResult(planningEvents, targetRead).data.status, "succeeded");

    const discoveryCompletedIndex = planningEvents.findIndex(
      (event) => event.kind === "discovery.completed",
    );
    const planProposedIndex = planningEvents.findIndex((event) => event.kind === "plan.proposed");
    assert.ok(discoveryCompletedIndex >= 0, "verified Discovery must complete before handoff");
    assert.equal(planProposedIndex, discoveryCompletedIndex + 1);
    const discoveryCompleted = planningEvents[discoveryCompletedIndex];
    const planProposed = planningEvents[planProposedIndex];
    assert.ok(discoveryCompleted?.kind === "discovery.completed");
    assert.ok(planProposed?.kind === "plan.proposed");
    assert.equal(discoveryCompleted.data.operationId, planProposed.data.operationId);
    assert.ok(discoveryCompleted.data.report.evidenceRefs.length > 0);
    assert.match(
      JSON.stringify(planProposed.data.proposal),
      new RegExp(escapeRegExp(fixture.targetPath), "u"),
    );
    assert.match(
      JSON.stringify(planProposed.data.proposal),
      new RegExp(escapeRegExp(fixture.targetSymbol), "u"),
    );
    for (const decoyPath of fixture.decoyPaths.slice(0, 10)) {
      assert.doesNotMatch(
        JSON.stringify(planProposed.data.proposal),
        new RegExp(escapeRegExp(decoyPath), "u"),
      );
    }

    const discovery = planningState.discovery.latest;
    assert.equal(discovery?.status, "completed");
    assert.equal(planningState.discovery.active, undefined);
    assert.ok((discovery?.budget.consumedToolCalls ?? Number.POSITIVE_INFINITY) <= 24);
    assert.ok((discovery?.budget.consumedFiles ?? Number.POSITIVE_INFINITY) <= 30);
    assert.ok((discovery?.branches.length ?? Number.POSITIVE_INFINITY) <= 2);
    assert.ok((discovery?.cycle ?? Number.POSITIVE_INFINITY) <= 2);
    assert.ok(providerSnapshots[0]?.tools.includes("repo_map"));
    assert.ok(providerSnapshots.some((snapshot) => isPlanSystemPrompt(snapshot.system)));

    const executed = await runtime.approvePlanAndExecute(
      {
        approval: {
          sessionId: sandbox.sessionId,
          dir: sandbox.workDir,
          planId: handoff.planId,
          expectedRevision: handoff.revision,
          expectedSessionSequence: handoff.expectedSessionSequence,
          operationId: `approve:${randomUUID()}`,
        },
        execution: {
          ...modelRequest(model),
          sessionSelection: { mode: "resume", sessionId: sandbox.sessionId },
          interactionMode: "yolo",
          allowedTools: ["read_file", "edit_file", "update_plan", "cancel_plan"],
        },
      },
      runtimeHost(sandbox, model, providerSnapshots),
    );
    assert.equal(executed.handoff, undefined);

    const afterExecution = await workspaceHashes(sandbox.workDir);
    assert.deepEqual(changedPaths(beforePlanning, afterExecution), [fixture.targetPath]);
    const moduleUrl = `${pathToFileURL(join(sandbox.workDir, fixture.targetPath)).href}?${randomUUID()}`;
    const loaded = (await import(moduleUrl)) as Record<string, unknown>;
    const targetFunction = loaded[fixture.targetSymbol];
    assert.equal(typeof targetFunction, "function");
    assert.equal((targetFunction as () => unknown)(), fixture.expectedCanary);

    const finalState = await readRuntimeState(sandbox);
    assertClosedRuns(finalState.events, 2);
    assertMainModelSucceeded(finalState.events);
    const approvedIndex = finalState.events.findIndex((event) => event.kind === "plan.approved");
    const firstEditIndex = finalState.events.findIndex(
      (event) => event.kind === "tool.started" && event.data.toolName === "edit_file",
    );
    assert.ok(approvedIndex >= 0 && firstEditIndex > approvedIndex);
    assert.equal(
      finalState.events.some((event) => event.kind === "plan.execution.completed"),
      true,
    );
    assert.equal(isPlanSystemPrompt(providerSnapshots.at(-1)?.system ?? ""), false);
  },
);

realModelTest(
  "real deep discovery overlaps two read-only branches and settles one shared budget",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox();
    context.after(() => cleanupSandbox(sandbox));
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir);
    const before = await workspaceHashes(sandbox.workDir);
    const controlSessionId = `${sandbox.sessionId}-deep-control`;
    const controlStore = runtimeEventStore(sandbox);
    context.after(() => controlStore.close());
    await controlStore.initializeSession({ sessionId: controlSessionId, workDir: sandbox.workDir });
    const coordinator = discoveryCoordinator(controlStore, controlSessionId);
    await coordinator.start({
      operationId: "deep-start",
      discoveryId: "deep-discovery",
      objective: `并发定位 ${fixture.targetSymbol}`,
      depth: "deep",
    });
    await Promise.all([
      coordinator.startBranch({
        operationId: "deep-branch-entry-start",
        discoveryId: "deep-discovery",
        branchId: "entry-branch",
        ordinal: 0,
        objective: "从任务入口定位目标实现",
        queries: [fixture.targetSymbol],
        stoppingCondition: "读取目标定义并形成直接证据",
        reserveToolCalls: 24,
        reserveFiles: 40,
      }),
      coordinator.startBranch({
        operationId: "deep-branch-symbol-start",
        discoveryId: "deep-discovery",
        branchId: "symbol-branch",
        ordinal: 1,
        objective: "独立按符号地图定位目标实现",
        queries: [fixture.targetSymbol],
        stoppingCondition: "读取目标定义并形成直接证据",
        reserveToolCalls: 24,
        reserveFiles: 40,
      }),
    ]);

    const barrier = new TwoPartyModelBarrier();
    const [entryEvents, symbolEvents] = await Promise.all([
      executeReadOnlyInvestigation({
        sandbox,
        model,
        sessionId: `${sandbox.sessionId}-entry-branch`,
        mode: "new",
        beforeFirstModelCall: () => barrier.arrive(),
        prompt: branchInvestigationPrompt(fixture, "先读取任务说明，再从任务入口向目标收敛。"),
      }),
      executeReadOnlyInvestigation({
        sandbox,
        model,
        sessionId: `${sandbox.sessionId}-symbol-branch`,
        mode: "new",
        beforeFirstModelCall: () => barrier.arrive(),
        prompt: branchInvestigationPrompt(fixture, "独立从符号地图开始搜索，再核对任务说明。"),
      }),
    ]);

    assertMainModelSucceeded(entryEvents);
    assertMainModelSucceeded(symbolEvents);
    const entryTargetRead = requireTargetRead(entryEvents, sandbox.workDir, fixture.targetPath);
    const symbolTargetRead = requireTargetRead(symbolEvents, sandbox.workDir, fixture.targetPath);
    const entryEvidence = evidenceRef(entryTargetRead, "entry-branch");
    const symbolEvidence = evidenceRef(symbolTargetRead, "symbol-branch");
    const entryUsage = successfulResearchToolCount(entryEvents);
    const symbolUsage = successfulResearchToolCount(symbolEvents);
    const entryFiles = inspectedReadPaths(entryEvents, sandbox.workDir);
    const symbolFiles = inspectedReadPaths(symbolEvents, sandbox.workDir);
    assert.ok(entryUsage <= 24 && symbolUsage <= 24);
    assert.ok(entryFiles.includes(fixture.targetPath));
    assert.ok(symbolFiles.includes(fixture.targetPath));
    assertIntervalsOverlap(modelCallInterval(entryEvents), modelCallInterval(symbolEvents));

    const confirmedTarget = {
      path: fixture.targetPath,
      symbol: fixture.targetSymbol,
      score: 1,
      reasons: ["两个独立真实模型分支均直接读取目标定义"],
      evidenceRefs: [entryEvidence, symbolEvidence],
    } as const;
    await Promise.all([
      coordinator.checkpointBranch({
        operationId: "deep-branch-entry-checkpoint",
        discoveryId: "deep-discovery",
        branchId: "entry-branch",
        checkpoint: discoveryCheckpoint({
          toolCallsUsed: entryUsage,
          inspectedFiles: entryFiles,
          candidates: [confirmedTarget],
          evidenceRefs: [entryEvidence],
        }),
      }),
      coordinator.checkpointBranch({
        operationId: "deep-branch-symbol-checkpoint",
        discoveryId: "deep-discovery",
        branchId: "symbol-branch",
        checkpoint: discoveryCheckpoint({
          toolCallsUsed: symbolUsage,
          inspectedFiles: symbolFiles,
          candidates: [confirmedTarget],
          evidenceRefs: [symbolEvidence],
        }),
      }),
    ]);
    await Promise.all([
      coordinator.completeBranch({
        operationId: "deep-branch-entry-complete",
        discoveryId: "deep-discovery",
        branchId: "entry-branch",
        status: "completed",
        consumedToolCalls: entryUsage,
        inspectedFiles: entryFiles,
        candidates: [confirmedTarget],
        evidenceRefs: [entryEvidence],
      }),
      coordinator.completeBranch({
        operationId: "deep-branch-symbol-complete",
        discoveryId: "deep-discovery",
        branchId: "symbol-branch",
        status: "completed",
        consumedToolCalls: symbolUsage,
        inspectedFiles: symbolFiles,
        candidates: [confirmedTarget],
        evidenceRefs: [symbolEvidence],
      }),
    ]);
    await coordinator.checkpoint({
      operationId: "deep-verify",
      discoveryId: "deep-discovery",
      checkpoint: discoveryCheckpoint({
        phase: "verify",
        inspectedFiles: unique([...entryFiles, ...symbolFiles]),
        candidates: [confirmedTarget],
        evidenceRefs: [entryEvidence, symbolEvidence],
      }),
    });
    const completed = await coordinator.complete({
      operationId: "deep-complete",
      discoveryId: "deep-discovery",
      report: {
        summary: `两个分支确认 ${fixture.targetPath}`,
        confirmedTargets: [confirmedTarget],
        evidenceRefs: [entryEvidence, symbolEvidence],
        remainingRisks: [],
      },
    });

    const discovery = completed.latest;
    assert.equal(discovery?.status, "completed");
    assert.equal(discovery?.depth, "deep");
    assert.equal(discovery?.branches.length, 2);
    assert.deepEqual(
      discovery?.branches.map((branch) => branch.status),
      ["completed", "completed"],
    );
    assert.equal(discovery?.budget.consumedToolCalls, entryUsage + symbolUsage);
    assert.equal(discovery?.budget.consumedFiles, unique([...entryFiles, ...symbolFiles]).length);
    assert.ok((discovery?.budget.consumedToolCalls ?? 49) <= 48);
    assert.ok((discovery?.budget.consumedFiles ?? 81) <= 80);
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
    const controlEvents = await controlStore.readSession(controlSessionId);
    assert.equal(
      controlEvents.filter((event) => event.kind === "discovery.branch.started").length,
      2,
    );
    assert.equal(
      controlEvents.filter((event) => event.kind === "discovery.branch.completed").length,
      2,
    );
  },
);

realModelTest(
  "real discovery resumes after a durable checkpoint without repeating the same broad query",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox();
    context.after(() => cleanupSandbox(sandbox));
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir);
    const before = await workspaceHashes(sandbox.workDir);
    const controlSessionId = `${sandbox.sessionId}-resume-control`;
    const agentSessionId = `${sandbox.sessionId}-resume-agent`;
    let controlStore = runtimeEventStore(sandbox);
    context.after(() => controlStore.close());
    await controlStore.initializeSession({ sessionId: controlSessionId, workDir: sandbox.workDir });
    let coordinator = discoveryCoordinator(controlStore, controlSessionId);
    await coordinator.start({
      operationId: "resume-start",
      discoveryId: "resume-discovery",
      objective: `定位并恢复 ${fixture.targetSymbol} 的调查`,
      depth: "balanced",
    });
    await coordinator.startBranch({
      operationId: "resume-first-branch-start",
      discoveryId: "resume-discovery",
      branchId: "before-restart",
      ordinal: 0,
      objective: "先宽泛扫描，再定位并读取目标",
      queries: ["**/*.mjs", fixture.targetSymbol],
      stoppingCondition: "形成可恢复的目标候选和直接证据",
      reserveToolCalls: 12,
      reserveFiles: 15,
    });

    const firstEvents = await executeReadOnlyInvestigation({
      sandbox,
      model,
      sessionId: agentSessionId,
      mode: "new",
      allowedTools: ["glob", "read_file", "repo_map"],
      prompt: [
        `Read ${fixture.taskPath}.`,
        'Then call glob exactly once with arguments {"pattern":"**/*.mjs"} as the intentionally broad first query.',
        `Continue with repo_map query=${JSON.stringify(fixture.targetSymbol)} and max_files=200 until the symbol is found.`,
        "Read the exact target implementation, then stop with a concise checkpoint summary.",
        "Use no more than eight tool calls and do not modify files.",
      ].join("\n"),
    });
    assertMainModelSucceeded(firstEvents);
    const firstBroadCalls = broadGlobCalls(firstEvents);
    assert.equal(firstBroadCalls.length, 1, "the pre-restart run must establish one broad query");
    const previousBroadSignatures = new Set(firstBroadCalls.map(toolCallSignature));
    const firstTargetRead = requireTargetRead(firstEvents, sandbox.workDir, fixture.targetPath);
    const firstEvidence = evidenceRef(firstTargetRead, "before-restart");
    const firstUsage = successfulResearchToolCount(firstEvents);
    const firstFiles = inspectedReadPaths(firstEvents, sandbox.workDir);
    const candidate = {
      path: fixture.targetPath,
      symbol: fixture.targetSymbol,
      score: 1,
      reasons: ["重启前真实模型已直接读取定义"],
      evidenceRefs: [firstEvidence],
    } as const;
    await coordinator.checkpointBranch({
      operationId: "resume-first-branch-checkpoint",
      discoveryId: "resume-discovery",
      branchId: "before-restart",
      checkpoint: discoveryCheckpoint({
        toolCallsUsed: firstUsage,
        inspectedFiles: firstFiles,
        candidates: [candidate],
        evidenceRefs: [firstEvidence],
      }),
    });
    const focused = await coordinator.checkpoint({
      operationId: "resume-focus-checkpoint",
      discoveryId: "resume-discovery",
      checkpoint: discoveryCheckpoint({
        phase: "focus",
        inspectedFiles: firstFiles,
        candidates: [candidate],
        evidenceRefs: [firstEvidence],
      }),
    });
    const interrupted = await coordinator.interrupt({
      operationId: "resume-interrupt",
      expectedSessionSequence: focused.sessionSequence,
      discoveryId: "resume-discovery",
      reason: "simulate process restart after durable checkpoint",
    });
    assert.equal(interrupted.latest?.status, "interrupted");
    const consumedBeforeRestart = interrupted.latest?.budget;

    controlStore.close();
    const released = globalSessionManager.delete(agentSessionId, sandbox.workDir, {
      picoHome: sandbox.picoHome,
    });
    await released?.close();
    controlStore = runtimeEventStore(sandbox);
    coordinator = discoveryCoordinator(controlStore, controlSessionId);
    const restored = await coordinator.project();
    assert.equal(restored.latest?.status, "interrupted");
    assert.deepEqual(restored.latest?.budget, consumedBeforeRestart);
    const resumed = await coordinator.resume({
      operationId: "resume-after-restart",
      expectedSessionSequence: restored.sessionSequence,
      discoveryId: "resume-discovery",
      depth: "balanced",
    });
    assert.equal(
      resumed.active?.budget.consumedToolCalls,
      consumedBeforeRestart?.consumedToolCalls,
    );
    assert.equal(resumed.active?.budget.consumedFiles, consumedBeforeRestart?.consumedFiles);
    await coordinator.startBranch({
      operationId: "resume-second-branch-start",
      discoveryId: "resume-discovery",
      branchId: "after-restart",
      ordinal: 1,
      objective: "从持久候选直接核验目标，不重跑宽泛扫描",
      queries: [fixture.targetPath],
      stoppingCondition: "直接读取持久候选并核验证据",
      reserveToolCalls: 12,
      reserveFiles: 15,
    });

    const allAgentEvents = await executeReadOnlyInvestigation({
      sandbox,
      model,
      sessionId: agentSessionId,
      mode: "resume",
      allowedTools: ["glob", "read_file", "repo_map"],
      prompt: [
        "Resume from the durable Discovery checkpoint instead of restarting repository exploration.",
        `The confirmed candidate is ${fixture.targetPath} and the symbol is ${fixture.targetSymbol}.`,
        `Call read_file on ${fixture.targetPath} directly and verify the definition.`,
        'Do not repeat the previous broad glob query {"pattern":"**/*.mjs"}.',
        "Use no more than three tool calls, make no modifications, then stop.",
      ].join("\n"),
    });
    const secondEvents = latestRunEvents(allAgentEvents);
    assertMainModelSucceeded(secondEvents);
    assert.equal(
      broadGlobCalls(secondEvents).some((call) =>
        previousBroadSignatures.has(toolCallSignature(call)),
      ),
      false,
    );
    const secondTargetRead = requireTargetRead(secondEvents, sandbox.workDir, fixture.targetPath);
    const secondEvidence = evidenceRef(secondTargetRead, "after-restart");
    const secondUsage = successfulResearchToolCount(secondEvents);
    const secondFiles = inspectedReadPaths(secondEvents, sandbox.workDir);
    await coordinator.checkpointBranch({
      operationId: "resume-second-branch-checkpoint",
      discoveryId: "resume-discovery",
      branchId: "after-restart",
      checkpoint: discoveryCheckpoint({
        phase: "focus",
        toolCallsUsed: secondUsage,
        inspectedFiles: secondFiles,
        candidates: [candidate],
        evidenceRefs: [secondEvidence],
      }),
    });
    await coordinator.completeBranch({
      operationId: "resume-second-branch-complete",
      discoveryId: "resume-discovery",
      branchId: "after-restart",
      status: "completed",
      consumedToolCalls: secondUsage,
      inspectedFiles: secondFiles,
      candidates: [candidate],
      evidenceRefs: [secondEvidence],
    });
    await coordinator.checkpoint({
      operationId: "resume-verify",
      discoveryId: "resume-discovery",
      checkpoint: discoveryCheckpoint({
        phase: "verify",
        inspectedFiles: unique([...firstFiles, ...secondFiles]),
        candidates: [candidate],
        evidenceRefs: [firstEvidence, secondEvidence],
      }),
    });
    const completed = await coordinator.complete({
      operationId: "resume-complete",
      discoveryId: "resume-discovery",
      report: {
        summary: "重启后从持久候选直接完成核验",
        confirmedTargets: [candidate],
        evidenceRefs: [firstEvidence, secondEvidence],
        remainingRisks: [],
      },
    });
    assert.equal(completed.latest?.status, "completed");
    assert.ok(
      (completed.latest?.budget.consumedToolCalls ?? 0) >=
        (consumedBeforeRestart?.consumedToolCalls ?? 0),
    );
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
  },
);

async function executeReadOnlyInvestigation(input: {
  readonly sandbox: TestSandbox;
  readonly model: RealModel;
  readonly sessionId: string;
  readonly mode: "new" | "resume";
  readonly prompt: string;
  readonly allowedTools?: readonly string[];
  readonly beforeFirstModelCall?: () => Promise<void>;
}): Promise<RuntimeEvent[]> {
  const snapshots: ProviderSnapshot[] = [];
  await new AgentRuntime().execute(
    {
      ...modelRequest(input.model),
      prompt: input.prompt,
      dir: input.sandbox.workDir,
      sessionSelection: { mode: input.mode, sessionId: input.sessionId },
      interactionMode: "yolo",
      allowedTools: [...(input.allowedTools ?? ["read_file", "read_evidence", "repo_map"])],
    },
    runtimeHost(input.sandbox, input.model, snapshots, {
      maxTurns: 8,
      ...(input.beforeFirstModelCall ? { beforeFirstModelCall: input.beforeFirstModelCall } : {}),
    }),
  );
  return await readSessionEvents(input.sandbox, input.sessionId);
}

function branchInvestigationPrompt(fixture: DiscoveryLargeRepoFixture, strategy: string): string {
  return [
    strategy,
    `The task is ${fixture.taskPath}; the requested symbol is ${fixture.targetSymbol}.`,
    `Use repo_map with query=${JSON.stringify(fixture.targetSymbol)} and max_files=200, repeating only while complete=false and the symbol is absent.`,
    "After locating it, call read_file on the exact target implementation.",
    "Use no more than six tool calls, make no modifications, then return a concise evidence summary.",
  ].join("\n");
}

function runtimeEventStore(sandbox: TestSandbox): RuntimeEventStore {
  return new RuntimeEventStore({
    storageRoot: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace.root,
  });
}

function discoveryCoordinator(store: RuntimeEventStore, sessionId: string): DiscoveryCoordinator {
  return new DiscoveryCoordinator(store, {
    sessionId,
    invocationId: `discovery-e2e:${sessionId}`,
    runId: `discovery-e2e:${sessionId}`,
    turnId: `discovery-e2e:${sessionId}`,
  });
}

function discoveryCheckpoint(overrides: Partial<DiscoveryCheckpoint> = {}): DiscoveryCheckpoint {
  return {
    phase: "forage",
    cycle: 1,
    candidates: [],
    evidenceRefs: [],
    hypotheses: [],
    openQuestions: [],
    toolCallsUsed: 0,
    inspectedFiles: [],
    ...overrides,
  };
}

function successfulResearchToolCount(events: readonly RuntimeEvent[]): number {
  const researchTools = new Set(["read_file", "read_evidence", "glob", "grep", "repo_map"]);
  return events.filter(
    (event) =>
      event.kind === "tool.result.recorded" &&
      event.data.status === "succeeded" &&
      researchTools.has(event.data.toolName),
  ).length;
}

function inspectedReadPaths(events: readonly RuntimeEvent[], workDir: string): string[] {
  const paths: string[] = [];
  for (const call of toolCalls(events, "read_file")) {
    const path = parseArguments(call)["path"];
    if (typeof path !== "string" || !path) continue;
    paths.push(relative(workDir, resolve(workDir, path)).replaceAll("\\", "/"));
  }
  return unique(paths);
}

function requireTargetRead(
  events: readonly RuntimeEvent[],
  workDir: string,
  targetPath: string,
): ToolCall {
  const call = toolCalls(events, "read_file").find((candidate) =>
    sameWorkspacePath(workDir, parseArguments(candidate)["path"], targetPath),
  );
  assert.ok(call, `missing direct read of ${targetPath}`);
  assert.equal(successfulToolResult(events, call).data.status, "succeeded");
  return call;
}

function evidenceRef(call: ToolCall, scope: string): string {
  return `runtime-tool-call:${scope}:${call.id}`;
}

function broadGlobCalls(events: readonly RuntimeEvent[]): ToolCall[] {
  return toolCalls(events, "glob").filter((call) => {
    const input = parseArguments(call);
    return input["pattern"] === "**/*.mjs";
  });
}

function toolCallSignature(call: ToolCall): string {
  return `${call.name}:${stableJson(parseArguments(call))}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function latestRunEvents(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const runId = events.findLast((event) => event.kind === "run.started")?.runId;
  assert.ok(runId, "session has no persisted run");
  return events.filter((event) => event.runId === runId);
}

function modelCallInterval(events: readonly RuntimeEvent[]): {
  readonly startedAt: number;
  readonly settledAt: number;
} {
  const starts = events
    .filter((event) => event.kind === "model.call.started" && event.data.purpose === "main")
    .map((event) => Date.parse(event.at));
  const settlements = events
    .filter((event) => event.kind === "model.call.settled")
    .map((event) => Date.parse(event.at));
  assert.ok(starts.length > 0 && settlements.length > 0);
  return { startedAt: Math.min(...starts), settledAt: Math.max(...settlements) };
}

function assertIntervalsOverlap(
  left: { readonly startedAt: number; readonly settledAt: number },
  right: { readonly startedAt: number; readonly settledAt: number },
): void {
  assert.ok(
    Math.max(left.startedAt, right.startedAt) <= Math.min(left.settledAt, right.settledAt),
    `expected overlapping model intervals: ${JSON.stringify({ left, right })}`,
  );
}

class TwoPartyModelBarrier {
  private arrivals = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolveGate) => {
    this.release = resolveGate;
  });

  async arrive(): Promise<void> {
    this.arrivals++;
    if (this.arrivals === 2) this.release();
    await withTimeout(this.gate, 30_000, "parallel model branches did not reach the barrier");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function modelRequest(
  model: RealModel,
): Pick<
  RunAgentCliOptions,
  | "provider"
  | "baseURL"
  | "apiKey"
  | "model"
  | "modelRouteId"
  | "modelCapabilities"
  | "thinkingEffort"
> {
  return {
    provider: model.provider,
    baseURL: model.config.baseURL,
    apiKey: model.config.apiKey,
    model: model.config.model,
    modelRouteId: model.route.id,
    modelCapabilities: model.route.capabilities,
    ...(supportsThinkingOff(model.route) ? { thinkingEffort: "off" } : {}),
  };
}

function runtimeHost(
  sandbox: TestSandbox,
  model: RealModel,
  snapshots: ProviderSnapshot[],
  options: RuntimeHostOptions = {},
): RunAgentCliDependencies {
  return {
    picoHome: sandbox.picoHome,
    env: process.env,
    modelRouter: model.runtime.router,
    reporter: new SilentReporter(),
    providerDecorator: captureProviderSnapshots(snapshots, options.beforeFirstModelCall),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };
}

function captureProviderSnapshots(
  sink: ProviderSnapshot[],
  beforeFirstModelCall?: () => Promise<void>,
): NonNullable<RunAgentCliDependencies["providerDecorator"]> {
  return (provider) => {
    let firstModelCall = true;
    const beforeGenerate = async (): Promise<void> => {
      if (!firstModelCall) return;
      firstModelCall = false;
      await beforeFirstModelCall?.();
    };
    const capture = (
      messages: readonly Message[],
      tools: readonly { readonly name: string }[],
    ): void => {
      sink.push({
        system: messages.find((message) => message.role === "system")?.content ?? "",
        tools: tools.map((tool) => tool.name),
      });
    };
    const wrapped: LLMProvider = {
      ...(provider.modelName ? { modelName: provider.modelName } : {}),
      get requestCapabilities() {
        return provider.requestCapabilities;
      },
      generate: async (messages, tools, options) => {
        capture(messages, tools);
        await beforeGenerate();
        return await provider.generate(messages, tools, options);
      },
      ...(provider.generateStream
        ? {
            generateStream: async (messages, tools, onDelta, options) => {
              capture(messages, tools);
              await beforeGenerate();
              return await provider.generateStream!(messages, tools, onDelta, options);
            },
          }
        : {}),
    };
    return wrapped;
  };
}

function supportsThinkingOff(route: ModelRoute): boolean {
  const profile = route.capabilities.reasoningProfile;
  return profile.enabled === true && profile.levels.includes("off");
}

function isPlanSystemPrompt(value: string): boolean {
  return /Plan Mode|规划模式|submit_plan/u.test(value);
}

async function createSandbox(): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), "pico-discovery-real-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  return {
    root,
    workDir,
    picoHome,
    sessionId: `discovery-real-${randomUUID()}`,
  };
}

async function cleanupSandbox(sandbox: TestSandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

async function readRuntimeState(
  sandbox: TestSandbox,
): Promise<{ readonly events: RuntimeEvent[]; readonly discovery: DiscoveryProjection }> {
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace.root,
  });
  try {
    const entries = await store.readSessionEntries(sandbox.sessionId);
    return {
      events: entries.map(({ event }) => event),
      discovery: projectDiscoveryEntries(sandbox.sessionId, entries),
    };
  } finally {
    store.close();
  }
}

async function readSessionEvents(sandbox: TestSandbox, sessionId: string): Promise<RuntimeEvent[]> {
  const store = runtimeEventStore(sandbox);
  try {
    return await store.readSession(sessionId);
  } finally {
    store.close();
  }
}

function toolCalls(events: readonly RuntimeEvent[], name: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.kind !== "message.committed") continue;
    for (const call of event.data.message.toolCalls ?? []) {
      if (call.name === name) calls.push(call);
    }
  }
  return calls;
}

function successfulToolResult(events: readonly RuntimeEvent[], call: ToolCall) {
  const result = events.find(
    (event) =>
      event.kind === "tool.result.recorded" &&
      event.refs.toolCallId === call.id &&
      event.data.status === "succeeded",
  );
  assert.ok(result?.kind === "tool.result.recorded", `missing successful result for ${call.name}`);
  return result;
}

function successfulToolOutput(events: readonly RuntimeEvent[], call: ToolCall): string {
  const result = successfulToolResult(events, call);
  return result.data.body.storage === "inline"
    ? result.data.body.content
    : result.data.projection.text;
}

function parseArguments(call: ToolCall): Record<string, unknown> {
  const parsed = JSON.parse(call.arguments) as unknown;
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function sameWorkspacePath(workDir: string, value: unknown, expected: string): boolean {
  if (typeof value !== "string" || !value) return false;
  return relative(workDir, resolve(workDir, value)).replaceAll("\\", "/") === expected;
}

function assertClosedRuns(events: readonly RuntimeEvent[], expectedRuns: number): void {
  const starts = events.filter((event) => event.kind === "run.started");
  const terminals = events.filter((event) => event.kind === "run.terminal");
  assert.equal(starts.length, expectedRuns);
  assert.equal(terminals.length, expectedRuns);
  assert.deepEqual(
    new Set(terminals.map((event) => event.runId)),
    new Set(starts.map((event) => event.runId)),
  );
}

function assertMainModelSucceeded(events: readonly RuntimeEvent[]): void {
  const mainCallIds = new Set(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { kind: "model.call.started" }> =>
          event.kind === "model.call.started" && event.data.purpose === "main",
      )
      .map((event) => event.data.providerCallId),
  );
  assert.ok(mainCallIds.size > 0);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "model.call.settled" &&
        event.data.status === "succeeded" &&
        mainCallIds.has(event.data.providerCallId),
    ),
  );
}

async function workspaceHashes(workDir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hashes[relative(workDir, path).replaceAll("\\", "/")] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  };
  await visit(workDir);
  return hashes;
}

function changedPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
