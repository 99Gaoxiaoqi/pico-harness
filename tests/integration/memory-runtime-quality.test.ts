import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import { getOrCreateSessionSettings } from "../../src/input/session-settings.js";
import { AtomicMemoryLifecycle } from "../../src/runtime/atomic-memory-lifecycle.js";
import { isAutomationToolAllowed } from "../../src/safety/automation-tool-policy.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { sessionMemoryLane } from "../../src/memory/atomic/session-lane.js";
import { memorySessionKey } from "../../src/memory/atomic/runtime-contracts.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import {
  executeAgentRuntime,
  type RunAgentProviderFactory,
} from "../../src/runtime/agent-runtime.js";
import { atomicMemoryDatabasePath } from "../../src/runtime/atomic-memory-runtime.js";
import type { Message } from "../../src/schema/message.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { SqliteRuntimeControlStore } from "../../src/storage/sqlite/sqlite-runtime-control-store.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

const MEMORY_CANARY = "npm run reviewed-memory-canary";

test("Maka memory admission separates recall from extraction across runtime profiles", async (t) => {
  const profiles = [
    "plan",
    "side",
    "background",
    "background-restricted",
    "responses",
    "headless",
    "untrusted",
  ] as const;
  for (const profile of profiles) {
    await t.test(profile, async () => {
      const fixture = await createFixture(`profile-${profile}`);
      const sessionId = `memory-profile-${profile}`;
      const trust =
        profile === "untrusted"
          ? new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome })
          : await trustWorkspaces(fixture.picoHome, fixture.workspace);
      const lifecycle = new AtomicMemoryLifecycle();
      const triggers = ["memory_remember", "memory_extract"];
      const background = profile.startsWith("background");
      const toolsAllowed = profile !== "background-restricted";
      const canRecall = profile !== "headless" && profile !== "untrusted";
      const canExtract = profile === "side" || profile === "background";
      const hasTriggers = canExtract || profile === "responses";
      let calls = 0;
      let extractionCalls = 0;
      const store = openStore(fixture);
      try {
        await store.applyMutations({
          operationId: "seed-profile-memory",
          mutations: [
            {
              type: "create",
              item: {
                content: MEMORY_CANARY,
                kind: "knowledge",
                statementType: "fact",
                temporalType: "undated",
                scopeType: "workspace",
                scopeKey: workspaceKey(fixture),
                observedAt: 1,
                origin: "user_requested",
                keys: [{ key: "build", keyType: "concept", keyOrigin: "user" }],
                sources: [],
              },
            },
          ],
        });
        if (profile === "side") {
          const settings = getOrCreateSessionSettings({
            sessionId,
            cwd: fixture.workspace,
            picoHome: fixture.picoHome,
            provider: "openai",
            model: "test",
            modelRouteId: "test/test",
          });
          settings.sideConversation = true;
        }
        if (background) triggers.forEach((name) => assert.ok(isAutomationToolAllowed(name)));
        await executeAgentRuntime(
          {
            ...runtimeRequest(fixture.workspace, sessionId, "What is the build command?"),
            provider: profile === "responses" ? "responses" : "openai",
            allowedTools: hasTriggers ? triggers : [],
            ...(profile === "plan" ? { interactionMode: "plan" as const } : {}),
            ...(background
              ? {
                  execution: {
                    kind: "background" as const,
                    policy: {
                      mode: "yolo" as const,
                      backgroundEnabled: true,
                      trustedWorkspace: true,
                      toolNetworkPolicy: "disabled" as const,
                      allowedTools: toolsAllowed ? triggers : [],
                      hardlineVersion: "builtin-v1",
                      hookVersion: "workspace-v1",
                      createdAt: Date.now(),
                    },
                  },
                }
              : {}),
          },
          {
            picoHome: fixture.picoHome,
            memoryTrustStore: trust,
            backgroundTrustStore: trust,
            isolatedHeadless: profile === "headless",
            atomicMemoryLifecycle: lifecycle,
            reporter: new SilentReporter(),
            atomicMemoryModelFactory: async () => ({
              model: {
                async call() {
                  extractionCalls++;
                  return JSON.stringify({
                    status: "complete",
                    coverageStatus: "processed",
                    requestedStatus: "not_applicable",
                    requestedItems: [],
                    incidentalItems: [],
                  });
                },
              },
            }),
            provider: {
              async generate(messages, tools) {
                calls++;
                assert.equal(
                  currentVisibleUserContent(messages).includes(MEMORY_CANARY),
                  canRecall,
                );
                for (const name of triggers)
                  assert.equal(
                    tools.some((tool) => tool.name === name),
                    hasTriggers,
                    name,
                  );
                if (profile === "plan") {
                  return {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: "submit-memory-plan",
                        name: "submit_plan",
                        arguments: JSON.stringify({
                          title: "Use remembered build command",
                          steps: [{ title: "Verify", description: MEMORY_CANARY }],
                        }),
                      },
                    ],
                  };
                }
                if (profile === "responses") {
                  if (calls > 1)
                    assert.ok(
                      messages.some(
                        (message) =>
                          message.toolCallId === `unsupported-${calls - 1}` &&
                          message.content.includes("provider_unsupported"),
                      ),
                    );
                  if (calls <= 2)
                    return {
                      role: "assistant" as const,
                      content: "",
                      toolCalls: [
                        { id: `unsupported-${calls}`, name: triggers[calls - 1]!, arguments: "{}" },
                      ],
                    };
                } else if (canExtract && calls === 1) {
                  return {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [{ id: "extract-profile", name: "memory_extract", arguments: "{}" }],
                  };
                }
                return { role: "assistant" as const, content: "profile complete" };
              },
            },
          },
        );
        // Let terminal-triggered work settle before the host enters drain mode.
        await drainExtraction(fixture, sessionId);
        await lifecycle.close();
        assert.equal(extractionCalls, canExtract ? 1 : 0);
        assert.equal((await store.listItems({ workspaceKey: workspaceKey(fixture) })).length, 1);
      } finally {
        await lifecycle.close();
        store.close();
        await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("committed Session A atomic memory reaches Session B AgentRuntime prompt but not another workspace", async () => {
  const fixture = await createFixture("cross-session");
  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace, otherWorkspace);
  const sessionIds = ["quality-memory-a", "quality-memory-b", "quality-memory-other"];
  const stages: string[] = [];
  try {
    await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionIds[0]!,
        `请记住：这个项目固定使用 ${MEMORY_CANARY} 验证记忆。`,
        "memory_remember",
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: finalAnswerProvider("session A complete", "memory_remember"),
        atomicMemoryModelFactory: async () => ({
          model: {
            async call(request) {
              stages.push(request.stage);
              return successfulExtraction(request.prompt, MEMORY_CANARY);
            },
          },
        }),
        reporter: new SilentReporter(),
      },
    );
    const store = openStore(fixture);
    try {
      const items = await store.listItems({ workspaceKey: workspaceKey(fixture) });
      assert.equal(items.length, 1, "remember synchronously commits the item");
      assert.equal(items[0]!.item.origin, "user_requested");
      assert.equal(items[0]!.item.scopeType, "workspace");
      assert.equal(items[0]!.sources[0]!.sessionId, sessionKey(fixture, sessionIds[0]!));
      const settings = await store.readSettings(workspaceKey(fixture));
      await store.updateSettings({
        workspaceKey: workspaceKey(fixture),
        expectedVersion: settings.version,
        autoExtract: false,
      });
    } finally {
      store.close();
    }
    for (const [index, workspace] of [fixture.workspace, otherWorkspace].entries()) {
      const prompts: Message[][] = [];
      await executeAgentRuntime(
        runtimeRequest(workspace, sessionIds[index + 1]!, "What is the build command?"),
        {
          picoHome: fixture.picoHome,
          memoryTrustStore: trustStore,
          provider: capturingProvider(prompts, "recall complete"),
          atomicMemoryModelFactory: async () => {
            throw new Error("recall must not dispatch extraction");
          },
          reporter: new SilentReporter(),
        },
      );
      assert.equal(prompts[0]?.[0]?.content.includes(MEMORY_CANARY), false);
      assert.equal(
        currentVisibleUserContent(prompts[0] ?? []).includes(MEMORY_CANARY),
        index === 0,
      );
      if (index === 0)
        assert.match(currentVisibleUserContent(prompts[0] ?? []), /<atomic-memory-reference/u);
    }
    assert.deepEqual(stages, ["proposal", "canonicalize"]);
  } finally {
    await closeSessions(
      sessionIds,
      [fixture.workspace, fixture.workspace, otherWorkspace],
      fixture.picoHome,
    );
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("atomic memory settings independently gate recall and extraction work", async (context) => {
  const cases = [
    {
      name: "enabled=false",
      settings: { enabled: false },
      expectedRecall: false,
      expectedCalls: 0,
    },
    {
      name: "autoExtract=false",
      settings: { autoExtract: false },
      expectedRecall: true,
      expectedCalls: 0,
    },
    {
      name: "recallEnabled=false",
      settings: { recallEnabled: false },
      expectedRecall: false,
      expectedCalls: 1,
    },
  ] as const;
  for (const settingCase of cases) {
    await context.test(settingCase.name, async () => {
      const fixture = await createFixture(`settings-${settingCase.name.replaceAll(/\W/gu, "-")}`);
      const sessionId = `quality-${settingCase.name}`;
      const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
      let mainCalls = 0,
        extractionCalls = 0;
      const prompts: Message[][] = [];
      const store = openStore(fixture);
      try {
        await store.applyMutations({
          operationId: "seed-setting-canary",
          mutations: [
            {
              type: "create",
              item: {
                content: MEMORY_CANARY,
                kind: "knowledge",
                statementType: "fact",
                temporalType: "undated",
                scopeType: "workspace",
                scopeKey: workspaceKey(fixture),
                observedAt: 1,
                origin: "user_requested",
                keys: [{ key: "build", keyType: "concept", keyOrigin: "llm" }],
                sources: [{ sessionId: "seed", runId: "seed", turnId: "seed", eventId: "seed" }],
              },
            },
          ],
        });
        const settings = await store.readSettings(workspaceKey(fixture));
        await store.updateSettings({
          workspaceKey: workspaceKey(fixture),
          expectedVersion: settings.version,
          ...settingCase.settings,
        });
        await executeAgentRuntime(
          runtimeRequest(
            fixture.workspace,
            sessionId,
            "The build verification command for this workspace is npm run settings-review.",
            "memory_extract",
          ),
          {
            picoHome: fixture.picoHome,
            memoryTrustStore: trustStore,
            provider: {
              async generate(messages, tools) {
                prompts.push(structuredClone(messages));
                mainCalls++;
                if (mainCalls === 1) {
                  assert.ok(tools.some((tool) => tool.name === "memory_extract"));
                  return {
                    role: "assistant",
                    content: "",
                    toolCalls: [{ id: "settings", name: "memory_extract", arguments: "{}" }],
                  };
                }
                return { role: "assistant", content: "foreground complete" };
              },
            },
            atomicMemoryModelFactory: async () => ({
              model: {
                async call() {
                  extractionCalls++;
                  return emptyExtraction();
                },
              },
            }),
            reporter: new SilentReporter(),
          },
        );
        await drainExtraction(fixture, sessionId);
        assert.equal(
          mainCalls,
          2,
          "the atomic trigger remains available; policy gates extraction at execution",
        );
        assert.equal(prompts[0]?.[0]?.content.includes(MEMORY_CANARY), false);
        assert.equal(
          currentVisibleUserContent(prompts[0] ?? []).includes(MEMORY_CANARY),
          settingCase.expectedRecall,
        );
        assert.equal(extractionCalls, settingCase.expectedCalls);
        const cursor = await store.readExtractionCursor(sessionKey(fixture, sessionId));
        assert.equal(cursor !== undefined, settingCase.expectedCalls > 0);
        assert.equal(
          await store.readPendingExtractionFailure(sessionKey(fixture, sessionId)),
          undefined,
        );
        assert.equal((await store.listItems({ workspaceKey: workspaceKey(fixture) })).length, 1);
      } finally {
        store.close();
        await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test(
  "foreground streaming completion does not wait for blocked atomic extraction",
  { timeout: 10_000 },
  async () => {
    const fixture = await createFixture("streaming-nonblocking");
    const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
    const sessionId = "quality-streaming-nonblocking";
    const deferred = createDeferred<string>();
    const extractionStarted = createDeferred<void>();
    const reporter = new DeltaReporter();
    let extractionCalls = 0,
      streamCalls = 0;
    try {
      const result = await executeAgentRuntime(
        runtimeRequest(
          fixture.workspace,
          sessionId,
          "This project's build command is npm run stream-memory.",
          "memory_extract",
        ),
        {
          picoHome: fixture.picoHome,
          memoryTrustStore: trustStore,
          provider: {
            async generate() {
              throw new Error("streaming provider must use generateStream");
            },
            async generateStream(_messages, _tools, onDelta) {
              if (++streamCalls === 1)
                return {
                  role: "assistant",
                  content: "",
                  toolCalls: [{ id: "streaming", name: "memory_extract", arguments: "{}" }],
                };
              onDelta("stream");
              onDelta("ed");
              return {
                role: "assistant",
                content: "streamed",
                usage: { promptTokens: 7, completionTokens: 2 },
              };
            },
          },
          atomicMemoryModelFactory: async () => ({
            model: {
              async call() {
                extractionCalls++;
                extractionStarted.resolve();
                return deferred.promise;
              },
            },
          }),
          reporter,
        },
      );
      assert.equal(result.finalMessage, "streamed");
      assert.deepEqual(reporter.deltas, ["stream", "ed"]);
      await extractionStarted.promise;
      assert.equal(extractionCalls, 1);
      const store = openStore(fixture);
      try {
        assert.equal(await store.readExtractionCursor(sessionKey(fixture, sessionId)), undefined);
        deferred.resolve(emptyExtraction());
        await drainExtraction(fixture, sessionId);
        assert.ok(await store.readExtractionCursor(sessionKey(fixture, sessionId)));
        assert.equal(
          await store.readPendingExtractionFailure(sessionKey(fixture, sessionId)),
          undefined,
        );
      } finally {
        store.close();
      }
    } finally {
      deferred.resolve(emptyExtraction());
      await drainExtraction(fixture, sessionId);
      await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

test("atomic extraction failure cannot replace foreground terminal success", async () => {
  const fixture = await createFixture("extraction-failure");
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-extraction-failure";
  let extractionCalls = 0;
  try {
    const result = await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionId,
        "This project's build command is npm run failing-review.",
        "memory_extract",
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: finalAnswerProvider("foreground survived", "memory_extract"),
        atomicMemoryModelFactory: async () => ({
          model: {
            async call() {
              extractionCalls++;
              throw new Error("extraction provider unavailable");
            },
          },
        }),
        reporter: new SilentReporter(),
      },
    );
    assert.equal(result.finalMessage, "foreground survived");
    await drainExtraction(fixture, sessionId);
    assert.equal(extractionCalls, 3, "provider failure exhausts the bounded three-call budget");
    const store = openStore(fixture);
    try {
      assert.ok(await store.readPendingExtractionFailure(sessionKey(fixture, sessionId)));
      assert.equal(await store.readExtractionCursor(sessionKey(fixture, sessionId)), undefined);
    } finally {
      store.close();
    }
    const events = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
    try {
      assert.ok(
        (await events.readSession(sessionId)).some(
          (event) => event.kind === "run.terminal" && event.data.status === "completed",
        ),
      );
    } finally {
      events.close();
    }
  } finally {
    await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("default priced atomic extraction records memory_review without changing main Session usage", async () => {
  const fixture = await createFixture("priced-worker");
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-priced-worker";
  let providerInstances = 0,
    generateCalls = 0;
  const providerFactory: RunAgentProviderFactory = () => {
    providerInstances++;
    return {
      async generate(messages, tools) {
        const extractionPrompt = messages.at(-1)?.content ?? "";
        if (
          extractionPrompt.includes("<memory_evidence>") ||
          extractionPrompt.includes("<user_evidence_candidates>")
        ) {
          return {
            role: "assistant",
            content: successfulExtraction(extractionPrompt, "npm run priced-review"),
            usage: { promptTokens: 40, completionTokens: 20 },
          };
        }
        if (++generateCalls === 1 && tools.some((tool) => tool.name === "memory_extract")) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "priced", name: "memory_extract", arguments: "{}" }],
            usage: { promptTokens: 100, completionTokens: 50 },
          };
        }
        return {
          role: "assistant",
          content: "priced foreground complete",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    };
  };
  const capabilities = resolveModelRouteCapabilities(
    "openai",
    "quality-priced-model",
    {
      toolCall: true,
      price: {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1,
      },
    },
    { baseURL: "https://quality.example.test/v1" },
  );
  try {
    await executeAgentRuntime(
      {
        ...runtimeRequest(
          fixture.workspace,
          sessionId,
          "This project's build command is npm run priced-review.",
          "memory_extract",
        ),
        baseURL: "https://quality.example.test/v1",
        apiKey: "quality-priced-key",
        model: "quality-priced-model",
        modelRouteId: "quality/quality-priced-model",
        modelCapabilities: capabilities,
      },
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        providerFactory,
        reporter: new SilentReporter(),
      },
    );
    const session = globalSessionManager.get(sessionId, fixture.workspace, {
      picoHome: fixture.picoHome,
    });
    assert.ok(session);
    const usageBeforeExtraction = structuredClone(session.getRuntimeStateSnapshot().usage);
    await drainExtraction(fixture, sessionId);
    await waitForProviderCalls(fixture, 4);
    const usageAfterExtraction = session.getRuntimeStateSnapshot().usage;
    assert.deepEqual(usageAfterExtraction, usageBeforeExtraction);
    assert.equal(usageAfterExtraction.totalProviderCalls, 2);
    const store = openStore(fixture);
    try {
      assert.equal(
        (await store.listItems({ workspaceKey: workspaceKey(fixture) }))[0]?.item.content,
        "npm run priced-review",
      );
      assert.ok(await store.readExtractionCursor(sessionKey(fixture, sessionId)));
    } finally {
      store.close();
    }
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
    try {
      const calls = ledger.listProviderCalls();
      assert.deepEqual(calls.map((call) => call.purpose).sort(), [
        "main",
        "main",
        "memory_review",
        "memory_review",
      ]);
      for (const review of calls.filter((call) => call.purpose === "memory_review")) {
        assert.ok(review.cost > 0);
        assert.equal(review.reported?.["costStatus"], "estimated");
        assert.equal(review.inputTokens, 40);
        assert.equal(review.outputTokens, 20);
      }
    } finally {
      ledger.close();
    }
    assert.equal(
      providerInstances,
      2,
      "one foreground provider and one lease shared by proposal/canonicalization",
    );
  } finally {
    await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

class DeltaReporter extends SilentReporter {
  readonly deltas: string[] = [];
  onTextDelta(delta: string): void {
    this.deltas.push(delta);
  }
}

function successfulExtraction(prompt: string, content: string): string {
  const item = {
    content,
    kind: "knowledge",
    statementType: "fact",
    temporalType: "undated",
    eventStartedAt: null,
    eventEndedAt: null,
    scope: "workspace",
    keys: [{ key: "build", type: "concept" }],
  };
  if (prompt.includes("<user_evidence_candidates>"))
    return JSON.stringify({ results: [{ candidateId: "candidate_0", status: "accepted", item }] });
  const payload = prompt.split("<memory_evidence>\n")[1]?.split("\n</memory_evidence>")[0];
  assert.ok(payload);
  const evidence = JSON.parse(payload) as { sourceRef: string; texts: string[] }[];
  const source = evidence.find((entry) => entry.texts.some((text) => text.includes(content)));
  assert.ok(source, "fixture must cite actual durable user evidence");
  const proposed = { ...item, evidence: [{ sourceRef: source.sourceRef, quote: content }] };
  const requested = prompt.includes("The user explicitly requested memory.");
  return JSON.stringify({
    status: "complete",
    coverageStatus: "processed",
    requestedStatus: requested ? "resolved" : "not_applicable",
    requestedItems: requested ? [proposed] : [],
    incidentalItems: requested ? [] : [proposed],
  });
}

function emptyExtraction(): string {
  return JSON.stringify({
    status: "complete",
    coverageStatus: "processed",
    requestedStatus: "not_applicable",
    requestedItems: [],
    incidentalItems: [],
  });
}

function finalAnswerProvider(
  content: string,
  trigger: "memory_remember" | "memory_extract",
): LLMProvider {
  let calls = 0;
  return {
    async generate(_messages, tools) {
      if (calls++ === 0 && tools.some((tool) => tool.name === trigger))
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "quality-trigger", name: trigger, arguments: "{}" }],
        };
      return { role: "assistant", content, usage: { promptTokens: 10, completionTokens: 3 } };
    },
  };
}

function capturingProvider(captured: Message[][], content: string): LLMProvider {
  return {
    async generate(messages) {
      captured.push(structuredClone(messages));
      return { role: "assistant", content, usage: { promptTokens: 10, completionTokens: 3 } };
    },
  };
}

function currentVisibleUserContent(messages: readonly Message[]): string {
  return (
    messages.findLast(
      (message) =>
        message.role === "user" &&
        message.toolCallId === undefined &&
        message.providerData?.["picoHiddenFromTranscript"] !== true,
    )?.content ?? ""
  );
}

function runtimeRequest(
  workspace: string,
  sessionId: string,
  prompt: string,
  trigger?: "memory_remember" | "memory_extract",
) {
  return {
    prompt,
    dir: workspace,
    sessionSelection: { mode: "new" as const, sessionId },
    provider: "openai" as const,
    modelRouteId: "test/test",
    allowedTools: trigger ? [trigger] : [],
  };
}

function openStore(fixture: RuntimeFixture): SqliteMemoryItemStore {
  return new SqliteMemoryItemStore(atomicMemoryDatabasePath(fixture.picoHome));
}
function workspaceKey(fixture: RuntimeFixture): string {
  return resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace.id;
}
function sessionKey(fixture: RuntimeFixture, sessionId: string): string {
  return memorySessionKey(workspaceKey(fixture), sessionId);
}

async function drainExtraction(fixture: RuntimeFixture, sessionId: string): Promise<void> {
  // Runtime enqueues extraction before returning. A barrier in its session lane lets
  // assertions observe settled background work, including policy-denied no-ops.
  await sessionMemoryLane.run(
    `${fixture.picoHome}:${sessionKey(fixture, sessionId)}`,
    "background",
    async () => undefined,
  );
}

async function waitForProviderCalls(fixture: RuntimeFixture, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
    try {
      if (ledger.listProviderCalls().length === expected) return;
    } finally {
      ledger.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} provider calls`);
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve = (_value: Value): void => undefined;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface RuntimeFixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
}

async function createFixture(name: string): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-runtime-quality-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  return { root, workspace, picoHome };
}

async function trustWorkspaces(
  picoHome: string,
  ...workspaces: readonly string[]
): Promise<WorkspaceTrustStore> {
  const store = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  for (const workspace of workspaces) {
    await store.trust(await store.canonicalize(workspace));
  }
  return store;
}

async function closeSessions(
  sessionIds: readonly string[],
  workspaces: readonly string[],
  picoHome: string,
): Promise<void> {
  for (const [index, sessionId] of sessionIds.entries()) {
    const session = globalSessionManager.delete(sessionId, workspaces[index], { picoHome });
    await session?.close();
  }
}
