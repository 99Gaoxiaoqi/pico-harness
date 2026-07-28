import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { EvidenceArchive, formatEvidenceUri } from "../../src/context/evidence-archive.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import type {
  PersistedSessionSettings,
  SessionUsageSnapshot,
} from "../../src/engine/session-runtime.js";
import {
  forgetSessionSettings,
  resolveRestoredSessionModelRoute,
} from "../../src/input/session-settings.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import type { ToolCall } from "../../src/schema/message.js";
import { AgentRuntime, type RunAgentCliOptions } from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { projectRuntimeSessionUsage } from "../../src/runtime/runtime-session-projection.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";
import { ReadFileTool } from "../../src/tools/registry-impl.js";
import {
  configuredUserDefaultRealModel,
  loadUserDefaultRealModel,
  type RealModel,
} from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

interface TestSandbox {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
}

test("real-model configuration uses the user default without persisting credentials", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-real-llm-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workDir = join(root, "workspace");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  const userConfigStore = new UserConfigStore({ picoHome });
  await userConfigStore.write(
    {
      version: 1,
      defaults: { modelRouteId: "user-provider/user-model" },
      providers: {
        "user-provider": {
          protocol: "openai",
          baseURL: "https://user-provider.invalid/v1",
          apiKeyEnv: "PICO_REAL_LLM_TEST_KEY",
          models: ["user-model"],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: EMPTY_USER_CONFIG_REVISION },
  );
  const projectConfigPath = join(workDir, ".pico", "config.json");
  await writeFile(
    projectConfigPath,
    JSON.stringify({ version: 1, model: "project-provider/project-model" }),
    "utf8",
  );
  const syntheticCredential = "synthetic-real-llm-test-credential";
  const configured = await loadUserDefaultRealModel({
    picoHome,
    workDir,
    env: { PICO_REAL_LLM_TEST_KEY: syntheticCredential },
  });
  assert.equal(configured.route.id, "user-provider/user-model");
  if (configured.config.apiKey !== syntheticCredential) {
    throw new Error("真实模型测试未从用户 Provider 的环境引用解析凭证");
  }
  const persisted = `${await readFile(userConfigStore.filePath, "utf8")}\n${await readFile(
    projectConfigPath,
    "utf8",
  )}`;
  assert.equal(persisted.includes(syntheticCredential), false);
});

realModelTest(
  "restored session route is fail-closed before any real-model call",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const restored: PersistedSessionSettings = {
      provider: model.route.provider,
      model: model.route.model,
      modelRouteId: "removed-provider/removed-model",
      mode: "yolo",
      thinkingEffort: "off",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    };

    assert.throws(
      () => resolveRestoredSessionModelRoute(model.runtime.router, restored, model.route.id),
      /Pico 不会自动切换模型/u,
    );
  },
);

realModelTest(
  "real prompt Hook model call is enclosed by the canonical RuntimeRun",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("hook-deny");
    context.after(() => cleanupSandbox(sandbox));
    await writePromptDenyHook(sandbox.workDir);

    let outcome: "completed" | "hook-denied" = "completed";
    try {
      await new AgentRuntime().execute(
        runtimeRequest(sandbox, model, "Reply with PICO_MAIN_SHOULD_NOT_RUN.", "new"),
        runtimeHost(sandbox, model),
      );
    } catch (error) {
      if (!/UserPromptSubmit hook 阻断了输入/u.test(String(error))) throw error;
      outcome = "hook-denied";
    }

    const events = await readRuntimeEvents(sandbox);
    assertClosedRuns(events, 1);
    assertModelCallsArePaired(events);
    assertSucceededPurpose(events, "hook");
    const purposes = modelPurposes(events);
    assert.ok(purposes.includes("hook"));
    if (outcome === "completed") assertSucceededPurpose(events, "main");
    assert.equal(
      events.find((event) => event.kind === "run.terminal")?.data.status,
      outcome === "completed" ? "completed" : "failed",
    );
    assertNoUsageStateWrites(events);
  },
);

realModelTest(
  "real model recovers context and Usage only from RuntimeEvent facts",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("runtime-recovery");
    context.after(() => cleanupSandbox(sandbox));
    const marker = `PICO_RUNTIME_${randomUUID().replaceAll("-", "").toUpperCase()}`;

    const first = await new AgentRuntime().execute(
      runtimeRequest(
        sandbox,
        model,
        `Remember this exact marker for the next turn: ${marker}. Reply only ACK.`,
        "new",
      ),
      runtimeHost(sandbox, model),
    );
    assert.ok(first.finalMessage.trim().length > 0);

    await evictProcessState(sandbox);

    const second = await new AgentRuntime().execute(
      runtimeRequest(
        sandbox,
        model,
        "What exact marker did I ask you to remember? Reply only with that marker.",
        "resume",
      ),
      runtimeHost(sandbox, model),
    );
    assert.match(second.finalMessage, new RegExp(marker, "u"));

    const events = await readRuntimeEvents(sandbox);
    assertClosedRuns(events, 2);
    assertModelCallsArePaired(events);
    const purposes = modelPurposes(events);
    assert.ok(purposes.length >= 2);
    assert.ok(purposes.every((purpose) => purpose === "main"));
    assertSucceededPurpose(events, "main");
    assertNoUsageStateWrites(events);

    const projectedUsage = projectRuntimeSessionUsage(events);
    assert.ok(projectedUsage.totalProviderCalls >= 2);
    assert.ok(projectedUsage.totalPromptTokens > 0);
    assert.ok(projectedUsage.totalCompletionTokens > 0);

    const usageStore = new RuntimeStore({
      workDir: sandbox.workDir,
      picoHome: sandbox.picoHome,
    });
    const providerCalls = usageStore
      .listProviderCalls({ sessionId: sandbox.sessionId })
      .filter((record) => record.purpose === "main" && record.status === "succeeded");
    usageStore.close();
    assert.equal(providerCalls.length, 2);
    const firstDiagnostic = requestDiagnostic(providerCalls[0]);
    const secondDiagnostic = requestDiagnostic(providerCalls[1]);
    assert.equal(firstDiagnostic["changeReason"], "first_request");
    assert.equal(secondDiagnostic["changeReason"], "cacheable_prefix_changed");
    const firstChanged = secondDiagnostic["firstChangedCacheableSegment"];
    assert.equal(typeof firstChanged, "object");
    assert.ok(firstChanged);
    assert.equal((firstChanged as Record<string, unknown>)["kind"], "message");
    assert.equal(JSON.stringify(providerCalls).includes(marker), false);

    await evictProcessState(sandbox);
    const recovered = await globalSessionManager.getOrCreate(sandbox.sessionId, sandbox.workDir, {
      persistence: true,
      picoHome: sandbox.picoHome,
    });
    assert.match(
      recovered
        .getModelContext()
        .map((message) => message.content)
        .join("\n"),
      new RegExp(marker, "u"),
    );
    assertUsageEquals(recovered.getRuntimeStateSnapshot().usage, projectedUsage);
  },
);

realModelTest(
  "large ToolResult is archived and read back through Evidence",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("large-tool-result");
    context.after(() => cleanupSandbox(sandbox));
    const fileName = "large-evidence.txt";
    const marker = `PICO_LARGE_EVIDENCE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const sourceLines = Array.from(
      { length: 128 },
      (_, index) => `${String(index + 1).padStart(3, "0")}|证据回读😀|${"数据".repeat(35)}`,
    );
    sourceLines[11] = `012|${marker}|${"中段".repeat(10)}`;
    const source = `${sourceLines.join("\n")}\n`;
    const sourceBytes = Buffer.byteLength(source, "utf8");
    assert.ok(sourceBytes >= 20 * 1024);
    assert.ok(sourceBytes <= 30 * 1024);
    await writeFile(join(sandbox.workDir, fileName), source, "utf8");

    const readFileArguments = JSON.stringify({ path: fileName });
    const expectedRawOutput = await new ReadFileTool(sandbox.workDir).execute(readFileArguments);
    const markerIndex = expectedRawOutput.indexOf(marker);
    assert.ok(markerIndex > 0);
    const markerOffsetBytes = Buffer.byteLength(expectedRawOutput.slice(0, markerIndex), "utf8");
    assert.ok(markerOffsetBytes >= 2 * 1024);
    assert.ok(markerOffsetBytes <= 3 * 1024);
    const offsetBytes = 0;
    const limitBytes = 4_096;

    const result = await new AgentRuntime().execute(
      runtimeRequest(
        sandbox,
        model,
        [
          "严格按顺序执行，不得并行调用工具，也不得猜测文件中的 marker：",
          `1. 仅调用一次 read_file，参数必须是 ${readFileArguments}。`,
          "2. 从该工具返回的有界预览中复制完整 Evidence URI。",
          `3. 仅调用一次 read_evidence，ref 使用该 URI，offsetBytes 必须是 ${offsetBytes}，limitBytes 必须是 ${limitBytes}。`,
          "4. 从回读页找到以 PICO_LARGE_EVIDENCE_ 开头的完整 token，最终只输出该 token，不要解释。",
        ].join("\n"),
        "new",
        ["read_file", "read_evidence"],
      ),
      runtimeHost(sandbox, model),
    );
    assert.equal(result.finalMessage.trim(), marker);

    const events = await readRuntimeEvents(sandbox);
    assertClosedRuns(events, 1);
    assertModelCallsArePaired(events);
    assert.deepEqual(
      events.filter((event) => event.kind === "tool.started").map((event) => event.data.toolName),
      ["read_file", "read_evidence"],
    );

    const fileRead = singleToolExchange(events, "read_file");
    assert.deepEqual(JSON.parse(fileRead.call.arguments), { path: fileName });
    const expectedBytes = Buffer.byteLength(expectedRawOutput, "utf8");
    const expectedHash = sha256Utf8(expectedRawOutput);
    assert.equal(fileRead.result.data.status, "succeeded");
    assert.deepEqual(fileRead.result.data.body, {
      storage: "evidence",
      sha256: expectedHash,
      sizeBytes: expectedBytes,
    });
    assert.equal(fileRead.result.data.projection.mode, "preview");
    assert.equal(fileRead.result.data.projection.truncated, true);
    assert.doesNotMatch(fileRead.result.data.projection.text, new RegExp(marker, "u"));

    const evidence = fileRead.result.refs.evidence;
    assert.ok(evidence);
    assert.equal(evidence.sessionId, sandbox.sessionId);
    const evidenceBaseDir = resolvePicoPaths(sandbox.workDir, {
      picoHome: sandbox.picoHome,
    }).workspace.evidence;
    const archive = new EvidenceArchive({ baseDir: evidenceBaseDir });
    assert.equal(await archive.readRuntimeToolOutput(evidence), expectedRawOutput);
    const manifest = await archive.readRuntimeToolExchange(evidence);
    assert.equal(manifest.schemaVersion, 2);
    if (manifest.schemaVersion !== 2) assert.fail("expected Runtime Evidence v2");
    assert.equal(manifest.content.toolCallId, fileRead.call.id);
    assert.equal(manifest.content.toolName, "read_file");
    assert.equal(manifest.content.rawOutput.digest, expectedHash);
    assert.equal(manifest.content.rawOutput.sizeBytes, expectedBytes);

    const evidenceRead = singleToolExchange(events, "read_evidence");
    assert.ok(events.indexOf(fileRead.result) < events.indexOf(evidenceRead.callEvent));
    assert.deepEqual(JSON.parse(evidenceRead.call.arguments), {
      ref: formatEvidenceUri(evidence),
      offsetBytes,
      limitBytes,
    });
    assert.equal(evidenceRead.result.data.status, "succeeded");
    assert.equal(evidenceRead.result.refs.evidence, undefined);
    assert.equal(evidenceRead.result.data.body.storage, "inline");
    if (evidenceRead.result.data.body.storage !== "inline") {
      assert.fail("read_evidence result must stay inline");
    }
    const readback = evidenceRead.result.data.body.content;
    assert.match(readback, new RegExp(marker, "u"));
    assert.match(readback, /\[Evidence tool-exchange bytes \d+-\d+\/\d+\]/u);
    assert.ok(readback.includes(`/${expectedBytes}]`));
    assert.equal(evidenceRead.result.data.body.sha256, sha256Utf8(readback));
    assert.equal(evidenceRead.result.data.body.sizeBytes, Buffer.byteLength(readback, "utf8"));
    assert.deepEqual(evidenceRead.result.data.projection, {
      version: 1,
      mode: "full",
      text: readback,
      strategy: "bounded-readback",
      truncated: false,
    });
  },
);

async function createSandbox(label: string): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), `pico-${label}-real-llm-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  return {
    root,
    workDir,
    picoHome,
    sessionId: `real-llm-${label}-${randomUUID()}`,
  };
}

async function cleanupSandbox(sandbox: TestSandbox): Promise<void> {
  await evictProcessState(sandbox);
  globalApprovalManager.clear();
  await rm(sandbox.root, { recursive: true, force: true });
}

async function evictProcessState(sandbox: TestSandbox): Promise<void> {
  const session = globalSessionManager.delete(sandbox.sessionId, sandbox.workDir, {
    picoHome: sandbox.picoHome,
  });
  await session?.close();
  forgetSessionSettings(sandbox.sessionId, sandbox.workDir, sandbox.picoHome);
}

async function writePromptDenyHook(workDir: string): Promise<void> {
  await writeFile(
    join(workDir, ".pico", "hooks.json"),
    JSON.stringify(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "prompt",
                prompt:
                  'This is a deterministic integration check. Return {"ok":false,"reason":"PICO_HOOK_DENIED"}. Do not choose any other values.',
                timeout: 120,
              },
            ],
          },
        ],
      },
      undefined,
      2,
    ),
    "utf8",
  );
}

function runtimeRequest(
  sandbox: TestSandbox,
  model: RealModel,
  prompt: string,
  mode: "new" | "resume",
  allowedTools: readonly string[] = [],
): RunAgentCliOptions {
  return {
    prompt,
    dir: sandbox.workDir,
    sessionSelection: { mode, sessionId: sandbox.sessionId },
    provider: model.provider,
    baseURL: model.config.baseURL,
    apiKey: model.config.apiKey,
    model: model.config.model,
    modelRouteId: model.route.id,
    modelCapabilities: model.route.capabilities,
    thinkingEffort: supportsThinkingOff(model.route) ? "off" : undefined,
    allowedTools,
  };
}

function runtimeHost(sandbox: TestSandbox, model: RealModel) {
  return {
    picoHome: sandbox.picoHome,
    env: process.env,
    modelRouter: model.runtime.router,
    reporter: new SilentReporter(),
  };
}

function supportsThinkingOff(route: ModelRoute): boolean {
  const profile = route.capabilities.reasoningProfile;
  return profile.enabled === true && profile.levels.includes("off");
}

async function readRuntimeEvents(sandbox: TestSandbox): Promise<RuntimeEvent[]> {
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace.root,
  });
  try {
    return await store.readSession(sandbox.sessionId);
  } finally {
    store.close();
  }
}

function assertClosedRuns(events: readonly RuntimeEvent[], expectedRuns: number): void {
  const starts = events.filter((event) => event.kind === "run.started");
  const terminals = events.filter((event) => event.kind === "run.terminal");
  assert.equal(starts.length, expectedRuns);
  assert.equal(terminals.length, expectedRuns);
  assert.equal(new Set(starts.map((event) => event.runId)).size, expectedRuns);
  assert.equal(new Set(terminals.map((event) => event.runId)).size, expectedRuns);
  assert.deepEqual(
    new Set(terminals.map((event) => event.runId)),
    new Set(starts.map((event) => event.runId)),
  );
}

function assertModelCallsArePaired(events: readonly RuntimeEvent[]): void {
  const started = events.filter((event) => event.kind === "model.call.started");
  const settled = events.filter((event) => event.kind === "model.call.settled");
  assert.ok(started.length > 0);
  assert.equal(settled.length, started.length);
  const startedByCallId = new Map<string, Extract<RuntimeEvent, { kind: "model.call.started" }>>();
  for (const event of started) {
    assert.equal(startedByCallId.has(event.data.providerCallId), false);
    startedByCallId.set(event.data.providerCallId, event);
  }
  const settledCallIds = new Set<string>();
  for (const event of settled) {
    assert.equal(settledCallIds.has(event.data.providerCallId), false);
    settledCallIds.add(event.data.providerCallId);
    const matchingStart = startedByCallId.get(event.data.providerCallId);
    assert.ok(matchingStart);
    assert.equal(event.runId, matchingStart.runId);
  }
  assert.equal(settledCallIds.size, startedByCallId.size);
  const succeeded = settled.filter((event) => event.data.status === "succeeded");
  assert.ok(succeeded.length > 0);
  assert.ok(succeeded.every((event) => event.data.usage !== undefined));
}

function assertSucceededPurpose(
  events: readonly RuntimeEvent[],
  purpose: Extract<RuntimeEvent, { kind: "model.call.started" }>["data"]["purpose"],
): void {
  const started = events.filter((event) => event.kind === "model.call.started");
  const callIds = new Set(
    started
      .filter((event) => event.data.purpose === purpose)
      .map((event) => event.data.providerCallId),
  );
  assert.ok(callIds.size > 0, `Expected a ${purpose} model call`);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "model.call.settled" &&
        event.data.status === "succeeded" &&
        callIds.has(event.data.providerCallId),
    ),
    `Expected a succeeded ${purpose} model call`,
  );
}

function modelPurposes(events: readonly RuntimeEvent[]): string[] {
  return events
    .filter((event) => event.kind === "model.call.started")
    .map((event) => event.data.purpose);
}

function assertNoUsageStateWrites(events: readonly RuntimeEvent[]): void {
  const usageWrites = events.filter(
    (event) =>
      event.kind === "session.state.committed" &&
      Object.prototype.hasOwnProperty.call(event.data.patch, "usage"),
  );
  assert.equal(usageWrites.length, 0);
}

type MessageCommittedEvent = Extract<RuntimeEvent, { kind: "message.committed" }>;
type ToolStartedEvent = Extract<RuntimeEvent, { kind: "tool.started" }>;
type ToolResultRecordedEvent = Extract<RuntimeEvent, { kind: "tool.result.recorded" }>;

function singleToolExchange(
  events: readonly RuntimeEvent[],
  toolName: string,
): {
  readonly call: ToolCall;
  readonly callEvent: MessageCommittedEvent;
  readonly started: ToolStartedEvent;
  readonly result: ToolResultRecordedEvent;
} {
  const calls: Array<{
    readonly call: ToolCall;
    readonly callEvent: MessageCommittedEvent;
  }> = [];
  for (const event of events) {
    if (event.kind !== "message.committed") continue;
    for (const call of event.data.message.toolCalls ?? []) {
      if (call.name === toolName) calls.push({ call, callEvent: event });
    }
  }
  assert.equal(calls.length, 1);
  const recorded = calls[0];
  assert.ok(recorded);
  const starts = events.filter(
    (event): event is ToolStartedEvent =>
      event.kind === "tool.started" && event.refs?.toolCallId === recorded.call.id,
  );
  const results = events.filter(
    (event): event is ToolResultRecordedEvent =>
      event.kind === "tool.result.recorded" && event.refs.toolCallId === recorded.call.id,
  );
  assert.equal(starts.length, 1);
  assert.equal(results.length, 1);
  const started = starts[0];
  const result = results[0];
  assert.ok(started);
  assert.ok(result);
  assert.equal(started.data.toolName, toolName);
  assert.equal(result.data.toolName, toolName);
  assert.ok(events.indexOf(recorded.callEvent) < events.indexOf(started));
  assert.ok(events.indexOf(started) < events.indexOf(result));
  return { ...recorded, started, result };
}

function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function assertUsageEquals(actual: SessionUsageSnapshot, expected: SessionUsageSnapshot): void {
  for (const key of Object.keys(expected) as (keyof SessionUsageSnapshot)[]) {
    if (key === "totalCostCNY") {
      assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9);
    } else {
      assert.equal(actual[key], expected[key], `Usage mismatch for ${key}`);
    }
  }
}

function requestDiagnostic(record: ProviderCallRecord | undefined): Record<string, unknown> {
  assert.ok(record);
  const diagnostic = record.reported?.["requestDiagnostic"];
  assert.equal(typeof diagnostic, "object");
  assert.ok(diagnostic);
  return diagnostic as Record<string, unknown>;
}
