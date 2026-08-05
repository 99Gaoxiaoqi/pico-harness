import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { projectDiscoveryEntries } from "../../src/discovery/reducer.js";
import type { DiscoveryProjection } from "../../src/discovery/contract.js";
import { SilentReporter } from "../../src/engine/reporter.js";
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
): RunAgentCliDependencies {
  return {
    picoHome: sandbox.picoHome,
    env: process.env,
    modelRouter: model.runtime.router,
    reporter: new SilentReporter(),
    providerDecorator: captureProviderSnapshots(snapshots),
  };
}

function captureProviderSnapshots(
  sink: ProviderSnapshot[],
): NonNullable<RunAgentCliDependencies["providerDecorator"]> {
  return (provider) => {
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
      generate: (messages, tools, options) => {
        capture(messages, tools);
        return provider.generate(messages, tools, options);
      },
      ...(provider.generateStream
        ? {
            generateStream: (messages, tools, onDelta, options) => {
              capture(messages, tools);
              return provider.generateStream!(messages, tools, onDelta, options);
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
