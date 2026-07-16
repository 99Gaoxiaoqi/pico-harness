import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { globalApprovalManager } from "../../src/approval/manager.js";
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
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../../src/provider/effective-model-runtime.js";
import type { ProviderConfig } from "../../src/provider/config.js";
import type { ProviderKind } from "../../src/provider/factory.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import { AgentRuntime, type RunAgentCliOptions } from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { projectRuntimeSessionUsage } from "../../src/runtime/runtime-session-projection.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_TIMEOUT_MS = 5 * 60_000;
const MODEL_CONFIG_HOME = mkdtemp(join(tmpdir(), "pico-real-llm-config-"));

after(async () => {
  await rm(await MODEL_CONFIG_HOME, { recursive: true, force: true });
});

interface RealModel {
  readonly runtime: EffectiveModelRuntime;
  readonly provider: ProviderKind;
  readonly config: ProviderConfig;
  readonly route: ModelRoute;
}

interface TestSandbox {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
}

let realModelPromise: Promise<RealModel> | undefined;

test(
  "restored session route is fail-closed before any real-model call",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const model = await configuredRealModel();
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

test(
  "real prompt Hook model call is enclosed by the canonical RuntimeRun",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredRealModel();
    const sandbox = await createSandbox("hook-deny");
    context.after(() => cleanupSandbox(sandbox));
    await writePromptDenyHook(sandbox.workDir);

    let outcome: "succeeded" | "hook-denied" = "succeeded";
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
    if (outcome === "succeeded") assertSucceededPurpose(events, "main");
    assert.equal(
      events.find((event) => event.kind === "run.terminal")?.data.status,
      outcome === "succeeded" ? "succeeded" : "failed",
    );
    assertNoUsageStateWrites(events);
  },
);

test(
  "real model recovers context and Usage only from runtime.sqlite facts",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredRealModel();
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

async function configuredRealModel(): Promise<RealModel> {
  realModelPromise ??= (async () => {
    const runtime = await loadEffectiveModelRuntime({
      workDir: PROJECT_ROOT,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: process.env.LLM_MODEL?.trim() || "unused-real-model-e2e-legacy-route",
      legacyModelExplicit: false,
      env: process.env,
      picoHome: await MODEL_CONFIG_HOME,
    });
    const configured = runtime.router.providerConfig(runtime.config.defaultModelRouteId);
    return { runtime, ...configured };
  })();
  return realModelPromise;
}

async function createSandbox(label: string): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), `pico-${label}-real-llm-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await copyFile(join(PROJECT_ROOT, ".pico", "config.json"), join(workDir, ".pico", "config.json"));
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
    allowedTools: [],
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
    databasePath: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace
      .runtimeDatabase,
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

function assertUsageEquals(actual: SessionUsageSnapshot, expected: SessionUsageSnapshot): void {
  for (const key of Object.keys(expected) as (keyof SessionUsageSnapshot)[]) {
    if (key === "totalCostCNY") {
      assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9);
    } else {
      assert.equal(actual[key], expected[key], `Usage mismatch for ${key}`);
    }
  }
}
