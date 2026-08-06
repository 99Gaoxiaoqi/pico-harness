import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import { projectDiscoveryEntries } from "../../src/discovery/reducer.js";
import type { DiscoveryProjection } from "../../src/discovery/contract.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import type { Message, ToolCall } from "../../src/schema/message.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { createDiscoveryLargeRepoFixture } from "../fixtures/discovery-large-repo.js";
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
  readonly activity?: ProviderActivity;
  readonly failAtModelCall?: number;
}

interface ProviderActivity {
  active: number;
  maxActive: number;
  calls: number;
}

realModelTest(
  "real discovery loop locates a late target, hands off a verified plan, and edits only after approval",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox();
    context.after(() => cleanupSandbox(sandbox));
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir, { decoyCount: 480 });
    const beforePlanning = await workspaceHashes(sandbox.workDir);
    const providerSnapshots: ProviderSnapshot[] = [];
    const runtime = new AgentRuntime();
    const initialQuery = "production request policy";

    const planned = await runtime.execute(
      {
        ...modelRequest(model),
        prompt: [
          `Read ${fixture.taskPath} first and investigate the requested behavior before planning.`,
          `Use repo_map once with query=${JSON.stringify(initialQuery)} and max_files=10.`,
          "The production target is deliberately outside that first bounded scan. When complete=false, do not claim it is missing.",
          "Read the deterministic acceptance script named in TASK.md, then follow and directly read every static import in the production call chain until you reach the implementation that returns the legacy value.",
          "Ignore same-symbol archived decoys that are not reachable from that production entrypoint, and ground the plan in direct reads of the complete call chain.",
          "Submit exactly one implementation step that changes only the confirmed target and verifies the returned canary by rereading it.",
          "Do not modify any file before approval. Finish by calling submit_plan exactly once.",
        ].join("\n"),
        dir: sandbox.workDir,
        sessionSelection: { mode: "new", sessionId: sandbox.sessionId },
        interactionMode: "plan",
        allowedTools: ["read_file", "read_evidence", "repo_map", "grep", "submit_plan"],
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
    const exactRepoMapCall = repoMapCalls.find(
      (call) => parseArguments(call)["query"] === initialQuery,
    );
    assert.ok(exactRepoMapCall, "planning must issue the requested exact Repo Map query");
    assert.equal(parseArguments(exactRepoMapCall)["max_files"], 10);
    const firstRepoMapOutput = successfulToolOutput(planningEvents, exactRepoMapCall);
    assert.match(firstRepoMapOutput, /complete=false/u);
    assert.doesNotMatch(firstRepoMapOutput, new RegExp(escapeRegExp(fixture.targetPath), "u"));
    for (const path of [
      fixture.verificationPath,
      fixture.entryPath,
      fixture.servicePath,
      fixture.routerPath,
      fixture.targetPath,
    ]) {
      requireTargetRead(planningEvents, sandbox.workDir, path);
    }

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
    for (const decoyPath of fixture.sameSymbolDecoyPaths) {
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
  "real /explore deep runs production delegation concurrently under one shared budget",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox();
    context.after(() => cleanupSandbox(sandbox));
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir, { decoyCount: 480 });
    const before = await workspaceHashes(sandbox.workDir);
    const controlStore = runtimeEventStore(sandbox);
    await controlStore.initializeSession({
      sessionId: sandbox.sessionId,
      workDir: sandbox.workDir,
    });
    const coordinator = discoveryCoordinator(controlStore, sandbox.sessionId);
    await coordinator.start({
      operationId: "deep-start",
      discoveryId: "deep-discovery",
      objective: "从可执行行为追踪生产策略实现，并排除未接入调用链的同名实现",
      depth: "deep",
    });
    controlStore.close();

    const activity: ProviderActivity = { active: 0, maxActive: 0, calls: 0 };
    const snapshots: ProviderSnapshot[] = [];
    await new AgentRuntime().execute(
      {
        ...modelRequest(model),
        prompt: [
          `Read ${fixture.taskPath} and run a production-style /explore deep investigation without modifying files.`,
          "Your first tool call must be exactly one delegate_task with completion_policy=required and three mode=explore, role=leaf tasks.",
          'Use disjoint roots: task 1 roots=["scripts","apps"] for the runnable entry; task 2 roots=["src","z-target"] for the production service/router/implementation; task 3 roots=["a-decoys"] for unreachable same-symbol alternatives.',
          "Give every task a concrete stopping_condition. Do not use worker, optional, detached, or nested delegation.",
          "After all branches return, personally read the acceptance script and follow the production imports through every layer to the implementation that returns the legacy value.",
          "Return the bounded Discovery report and stop. Do not implement the requested change.",
        ].join("\n"),
        dir: sandbox.workDir,
        sessionSelection: { mode: "new", sessionId: sandbox.sessionId },
        interactionMode: "yolo",
        discoveryRun: true,
        allowedTools: [
          "delegate_task",
          "read_file",
          "read_evidence",
          "repo_map",
          "glob",
          "grep",
          "code_symbols",
          "code_definition",
          "code_references",
          "code_call_hierarchy",
        ],
      },
      runtimeHost(sandbox, model, snapshots, { maxTurns: 12, activity }),
    );

    const completed = await readRuntimeState(sandbox);
    const discovery = completed.discovery.latest;
    assert.equal(discovery?.status, "completed");
    assert.equal(discovery?.depth, "deep");
    assert.equal(discovery?.branches.length, 3);
    assert.ok(discovery?.branches.every((branch) => branch.status !== "running"));
    assert.ok((discovery?.budget.consumedToolCalls ?? 49) <= 48);
    assert.ok((discovery?.budget.consumedFiles ?? 81) <= 80);
    assert.ok(
      activity.maxActive >= 2,
      `expected concurrent provider calls: ${stableJson(activity)}`,
    );
    assert.equal(toolCalls(completed.events, "delegate_task").length, 1);
    requireTargetRead(completed.events, sandbox.workDir, fixture.targetPath);
    assert.ok(
      discovery?.report?.confirmedTargets.some(
        (candidate) => candidate.path === fixture.targetPath,
      ),
    );
    for (const decoyPath of fixture.sameSymbolDecoyPaths) {
      assert.equal(
        discovery?.report?.confirmedTargets.some((candidate) => candidate.path === decoyPath),
        false,
      );
    }
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
    assert.equal(
      completed.events.filter((event) => event.kind === "discovery.branch.started").length,
      3,
    );
    assert.equal(
      completed.events.filter((event) => event.kind === "discovery.branch.completed").length,
      3,
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
    const fixture = await createDiscoveryLargeRepoFixture(sandbox.workDir, { decoyCount: 480 });
    const before = await workspaceHashes(sandbox.workDir);
    let controlStore = runtimeEventStore(sandbox);
    await controlStore.initializeSession({
      sessionId: sandbox.sessionId,
      workDir: sandbox.workDir,
    });
    let coordinator = discoveryCoordinator(controlStore, sandbox.sessionId);
    await coordinator.start({
      operationId: "resume-start",
      discoveryId: "resume-discovery",
      objective: "恢复生产策略行为的只读调查",
      depth: "quick",
    });
    controlStore.close();
    const snapshots: ProviderSnapshot[] = [];
    const interruptionActivity: ProviderActivity = { active: 0, maxActive: 0, calls: 0 };
    await assert.rejects(
      new AgentRuntime().execute(
        {
          ...modelRequest(model),
          prompt: [
            "Begin a production-style quick Discovery and establish a durable forage checkpoint.",
            'Call glob exactly once with {"pattern":"**/*.mjs"}; independently grep for handleProductionRequest in the workspace.',
            "Do not modify files. Continue after the tool results.",
          ].join("\n"),
          dir: sandbox.workDir,
          sessionSelection: { mode: "new", sessionId: sandbox.sessionId },
          interactionMode: "yolo",
          discoveryRun: true,
          allowedTools: ["glob", "grep"],
        },
        runtimeHost(sandbox, model, snapshots, {
          maxTurns: 6,
          activity: interruptionActivity,
          failAtModelCall: 2,
        }),
      ),
      /forced model interruption/u,
    );

    const interrupted = await readRuntimeState(sandbox);
    assert.equal(interrupted.discovery.latest?.status, "interrupted");
    assert.ok((interrupted.discovery.latest?.budget.consumedToolCalls ?? 0) > 0);
    assert.ok((interrupted.discovery.latest?.evidenceRefs.length ?? 0) > 0);
    const firstRunEvents = latestRunEvents(interrupted.events);
    const previousBroadSignatures = new Set(
      toolCalls(firstRunEvents).filter(isBroadSearchCall).map(broadSearchSignature),
    );
    assert.ok(previousBroadSignatures.size > 0, "pre-restart run must persist a broad search");
    const consumedBeforeRestart = interrupted.discovery.latest?.budget;

    const released = globalSessionManager.delete(sandbox.sessionId, sandbox.workDir, {
      picoHome: sandbox.picoHome,
    });
    await released?.close();
    controlStore = runtimeEventStore(sandbox);
    coordinator = discoveryCoordinator(controlStore, sandbox.sessionId);
    const restored = await coordinator.project();
    assert.equal(restored.latest?.status, "interrupted");
    assert.deepEqual(restored.latest?.budget, consumedBeforeRestart);
    const resumed = await coordinator.resume({
      operationId: "resume-after-restart",
      expectedSessionSequence: restored.sessionSequence,
      discoveryId: "resume-discovery",
      depth: "quick",
    });
    assert.equal(
      resumed.active?.budget.consumedToolCalls,
      consumedBeforeRestart?.consumedToolCalls,
    );
    assert.equal(resumed.active?.budget.consumedFiles, consumedBeforeRestart?.consumedFiles);
    controlStore.close();

    await new AgentRuntime().execute(
      {
        ...modelRequest(model),
        prompt: [
          "Resume the interrupted Discovery from its durable checkpoint and prior tool evidence.",
          `Read ${fixture.taskPath}, then use focused reads or scoped searches to follow the acceptance script and production imports to the real implementation.`,
          "Do not repeat any equivalent whole-repository Glob, Grep, or Repo Map search already present in the transcript.",
          "Directly read the final production implementation, return the bounded report, make no modifications, and stop.",
        ].join("\n"),
        dir: sandbox.workDir,
        sessionSelection: { mode: "resume", sessionId: sandbox.sessionId },
        interactionMode: "yolo",
        discoveryRun: true,
        allowedTools: ["glob", "grep", "repo_map", "read_file", "read_evidence"],
      },
      runtimeHost(sandbox, model, snapshots, { maxTurns: 10 }),
    );
    const finalState = await readRuntimeState(sandbox);
    const secondEvents = latestRunEvents(finalState.events);
    assertMainModelSucceeded(secondEvents);
    assert.equal(
      toolCalls(secondEvents)
        .filter(isBroadSearchCall)
        .some((call) => previousBroadSignatures.has(broadSearchSignature(call))),
      false,
    );
    requireTargetRead(secondEvents, sandbox.workDir, fixture.targetPath);
    assert.equal(finalState.discovery.latest?.status, "completed");
    assert.ok(
      (finalState.discovery.latest?.budget.consumedToolCalls ?? 0) >=
        (consumedBeforeRestart?.consumedToolCalls ?? 0),
    );
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
  },
);

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

function requireTargetRead(
  events: readonly RuntimeEvent[],
  workDir: string,
  targetPath: string,
): ToolCall {
  const call = toolCalls(events, "read_file").find((candidate) =>
    sameWorkspacePath(workDir, parseArguments(candidate)["path"], targetPath),
  );
  assert.ok(call, `missing direct read of ${targetPath}; tools=${boundedToolDiagnostics(events)}`);
  assert.equal(successfulToolResult(events, call).data.status, "succeeded");
  return call;
}

function isBroadSearchCall(call: ToolCall): boolean {
  const input = parseArguments(call);
  const path = typeof input["path"] === "string" ? input["path"].replace(/^\.\//u, "") : "";
  if (path !== "" && path !== ".") return false;
  if (call.name === "glob") {
    const pattern = String(input["pattern"] ?? "").replace(/^\.\//u, "");
    return pattern.startsWith("**/") || pattern === "**" || pattern === "*";
  }
  if (call.name === "repo_map") {
    const query = String(input["query"] ?? "").trim();
    return query.length === 0 || /repository|workspace|all files|全仓|全部/u.test(query);
  }
  return false;
}

function broadSearchSignature(call: ToolCall): string {
  const input = parseArguments(call);
  const normalized = {
    ...input,
    path: typeof input["path"] === "string" ? input["path"].replace(/^\.\//u, "") || "." : ".",
    ...(call.name === "glob" && typeof input["pattern"] === "string"
      ? { pattern: input["pattern"].replace(/^\.\//u, "") }
      : {}),
  };
  return `${call.name}:${stableJson(normalized)}`;
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

function modelRequest(
  model: RealModel,
): Pick<
  RunAgentCliOptions,
  "provider" | "baseURL" | "apiKey" | "model" | "modelRouteId" | "modelCapabilities"
> {
  return {
    provider: model.provider,
    baseURL: model.config.baseURL,
    apiKey: model.config.apiKey,
    model: model.config.model,
    modelRouteId: model.route.id,
    modelCapabilities: model.route.capabilities,
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
    providerDecorator: captureProviderSnapshots(
      snapshots,
      options.beforeFirstModelCall,
      options.activity,
      options.failAtModelCall,
    ),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
  };
}

function captureProviderSnapshots(
  sink: ProviderSnapshot[],
  beforeFirstModelCall?: () => Promise<void>,
  activity?: ProviderActivity,
  failAtModelCall?: number,
): NonNullable<RunAgentCliDependencies["providerDecorator"]> {
  return (provider) => {
    let firstModelCall = true;
    let localCalls = 0;
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
    const beforeProviderCall = async (): Promise<void> => {
      await beforeGenerate();
      localCalls++;
      if (activity) activity.calls++;
      const callNumber = activity?.calls ?? localCalls;
      if (failAtModelCall === callNumber) {
        throw new Error(`forced model interruption at call ${String(callNumber)}`);
      }
      if (activity) {
        activity.active++;
        activity.maxActive = Math.max(activity.maxActive, activity.active);
      }
    };
    const afterProviderCall = (): void => {
      if (activity) activity.active--;
    };
    const wrapped: LLMProvider = {
      ...(provider.modelName ? { modelName: provider.modelName } : {}),
      get requestCapabilities() {
        return provider.requestCapabilities;
      },
      generate: async (messages, tools, options) => {
        capture(messages, tools);
        await beforeProviderCall();
        try {
          return await provider.generate(messages, tools, options);
        } finally {
          afterProviderCall();
        }
      },
      ...(provider.generateStream
        ? {
            generateStream: async (messages, tools, onDelta, options) => {
              capture(messages, tools);
              await beforeProviderCall();
              try {
                return await provider.generateStream!(messages, tools, onDelta, options);
              } finally {
                afterProviderCall();
              }
            },
          }
        : {}),
    };
    return wrapped;
  };
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

function toolCalls(events: readonly RuntimeEvent[], name?: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const event of events) {
    if (event.kind !== "message.committed") continue;
    for (const call of event.data.message.toolCalls ?? []) {
      if (name === undefined || call.name === name) calls.push(call);
    }
  }
  return calls;
}

function boundedToolDiagnostics(events: readonly RuntimeEvent[]): string {
  const diagnostics = toolCalls(events)
    .slice(-12)
    .map((call) => {
      const result = events.find(
        (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === call.id,
      );
      return {
        name: call.name,
        arguments: parseArguments(call),
        status: result?.kind === "tool.result.recorded" ? result.data.status : "missing",
        projection:
          result?.kind === "tool.result.recorded"
            ? result.data.projection.text.slice(0, 240)
            : undefined,
      };
    });
  return JSON.stringify(diagnostics).slice(0, 4_000);
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
