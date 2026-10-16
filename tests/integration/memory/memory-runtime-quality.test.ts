import { physicalProviderFixture } from "../helpers/physical-provider.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { getOrCreateSessionSettings } from "@pico/pico-host/input/session-settings";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { isAutomationToolAllowed } from "@pico/runtime/automation-tool-policy";
import { globalSessionManager } from "@pico/pico-host/session";
import { sessionMemoryLane } from "@pico/runtime/atomic-memory/session-lane";
import { memorySessionKey } from "@pico/core/atomic-memory-runtime-contracts";
import { resolvePicoPaths } from "@pico/pico-host";
import type { LLMProvider } from "@pico/core";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { executeAgentRuntime, type RunAgentProviderFactory } from "@pico/pico-host/agent-runtime";
import { atomicMemoryDatabasePath } from "@pico/pico-host/atomic-memory-runtime";
import type { Message } from "@pico/core";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { BACKGROUND_HARDLINE_VERSION } from "@pico/pico-host/background-autonomous-policy";
import { createProvider } from "@pico/pico-host/provider/factory";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";

const MEMORY_CANARY = "npm run reviewed-memory-canary";

class DrainableMemoryLifecycle extends AtomicMemoryLifecycle {
  private readonly pending = new Set<Promise<unknown>>();

  override run<Value>(
    trigger: "remember" | "extract" | "compaction",
    operation: () => Promise<Value>,
    unavailable: () => Value,
  ): Promise<Value> {
    const task = super.run(trigger, operation, unavailable);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

test("Memory admission separates recall from extraction across runtime profiles", async (t) => {
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
    await t.test(profile, async (context) => {
      const fixture = await createFixture(`profile-${profile}`, context);
      const sessionId = `memory-profile-${profile}`;
      const trust =
        profile === "untrusted"
          ? new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome })
          : await trustWorkspaces(fixture.picoHome, fixture.workspace);
      const lifecycle = fixture.lifecycle;
      const triggers = ["memory_remember", "memory_extract"];
      const background = profile.startsWith("background");
      const toolsAllowed = profile !== "background-restricted";
      const canRecall = profile !== "headless" && profile !== "untrusted";
      const canExtract = profile === "side" || profile === "background" || profile === "responses";
      const hasTriggers = canExtract;
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
            ...(profile === "plan"
              ? { collaborationMode: "plan" as const, permissionMode: "ask" as const }
              : {}),
            ...(background
              ? {
                  execution: {
                    kind: "background" as const,
                    policy: {
                      mode: "full-access" as const,
                      backgroundEnabled: true,
                      trustedWorkspace: true,
                      toolNetworkPolicy: "disabled" as const,
                      allowedTools: toolsAllowed ? triggers : [],
                      hardlineVersion: BACKGROUND_HARDLINE_VERSION,
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
                if (canExtract && calls === 1) {
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

test("Responses真实HTTP适配器经原文证据提取并同步保存事实", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-responses-memory-"));
  const workspace = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "responses-memory";
  await mkdir(workspace);
  const trust = await trustWorkspaces(picoHome, workspace);
  const paths = resolvePicoPaths(workspace, { picoHome });
  const lifecycle = new AtomicMemoryLifecycle();
  const content = "npm run responses-memory-canary";
  const prompt = `请记住：这个项目的构建命令是 ${content}。`;
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
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/responses");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      assert.notEqual(body.stream, true);
      const input = body.input as Array<Record<string, unknown>>;
      const text = [
        typeof body.instructions === "string" ? body.instructions : "",
        ...input.flatMap((entry) =>
          typeof entry.content === "string"
            ? [entry.content]
            : Array.isArray(entry.content)
              ? entry.content.flatMap((part: Record<string, unknown>) =>
                  typeof part.text === "string" ? [part.text] : [],
                )
              : [],
        ),
      ].join("\n");
      let answer: string | undefined;
      let tool = false;
      if (text.includes("<user_evidence_candidates>"))
        answer = JSON.stringify({
          results: [{ candidateId: "candidate_0", status: "accepted", item }],
        });
      else if (text.includes("<memory_evidence>")) {
        const evidence = JSON.parse(
          text.split("<memory_evidence>\n")[1]!.split("\n</memory_evidence>")[0]!,
        ) as Array<{ sourceRef: string }>;
        const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
        let sourceRef: string;
        try {
          const user = (await events.readSessionEntries(sessionId)).find(
            ({ event }) =>
              event.kind === "message.committed" &&
              event.data.message.role === "user" &&
              event.data.message.content === prompt,
          );
          assert.ok(user);
          sourceRef = `event:${user.event.eventId}`;
          assert.ok(
            evidence.some((entry) => entry.sourceRef === sourceRef),
            "Responses请求必须保留真实canonical用户来源",
          );
        } finally {
          events.close();
        }
        assert.ok(text.includes(content));
        answer = JSON.stringify({
          status: "complete",
          coverageStatus: "processed",
          requestedStatus: "resolved",
          requestedItems: [{ ...item, evidence: [{ sourceRef, quote: content }] }],
          incidentalItems: [],
        });
      } else if (input.some((entry) => entry.type === "function_call_output"))
        answer = "已保存构建命令。";
      else tool = true;
      const output = tool
        ? [
            {
              type: "function_call",
              id: "fc_remember",
              call_id: "remember-call",
              name: "memory_remember",
              arguments: "{}",
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: `msg_${requests.length}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: answer, annotations: [] }],
            },
          ];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `resp_${requests.length}`,
          object: "response",
          created_at: 1,
          model: "test-model",
          status: "completed",
          output,
          usage: { input_tokens: 16, output_tokens: 8, total_tokens: 24 },
        }),
      );
    } catch (error) {
      errors.push(error);
      res.writeHead(400);
      res.end('{"error":{"message":"fixture assertion failed"}}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await closeExecutionLearningWorker(picoHome);
    await lifecycle.close();
    await closeSessions([sessionId], [workspace], picoHome);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await executeAgentRuntime(
    {
      ...runtimeRequest(workspace, sessionId, prompt, "memory_remember"),
      provider: "responses",
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: "test-key",
      model: "test-model",
    },
    {
      picoHome,
      maxTurns: 4,
      memoryTrustStore: trust,
      atomicMemoryLifecycle: lifecycle,
      reporter: new SilentReporter(),
      providerFactory: (kind, config, effort, dependencies) => {
        assert.equal(kind, "responses");
        const adapter = createProvider(
          kind,
          {
            ...config,
            baseURL: `http://127.0.0.1:${address.port}`,
            apiKey: "test-key",
            capabilities: resolveModelRouteCapabilities(kind, "test-model", {
              output: 4096,
              toolCall: true,
              cache: false,
              toolChoiceNoneWithTools: true,
            }),
          },
          effort,
          dependencies,
        );
        return {
          modelName: adapter.modelName,
          requestCapabilities: adapter.requestCapabilities,
          generate: adapter.generate.bind(adapter),
        };
      },
    },
  );
  assert.deepEqual(errors, []);
  const store = new SqliteMemoryItemStore(atomicMemoryDatabasePath(picoHome));
  try {
    const saved = await store.listItems({ workspaceKey: paths.workspace.id });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.item.content, content);
    assert.equal(saved[0]!.sources[0]!.sessionId, memorySessionKey(paths.workspace.id, sessionId));
    assert.equal(saved[0]!.item.origin, "user_requested");
  } finally {
    store.close();
  }
  assert.equal(requests.length, 4, "两次前台和两次受限提取请求完成闭环");
});

test("committed Session A atomic memory reaches Session B AgentRuntime prompt but not another workspace", async (context) => {
  const fixture = await createFixture("cross-session", context);
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
        atomicMemoryLifecycle: fixture.lifecycle,
        provider: finalAnswerProvider("session A complete", "memory_remember"),
        atomicMemoryModelFactory: async () => ({
          model: {
            async call(request) {
              stages.push(request.stage);
              return successfulExtraction(request.prompt, MEMORY_CANARY, request.sourceMessages);
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
          atomicMemoryLifecycle: fixture.lifecycle,
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
    await context.test(settingCase.name, async (child) => {
      const fixture = await createFixture(
        `settings-${settingCase.name.replaceAll(/\W/gu, "-")}`,
        child,
      );
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
            atomicMemoryLifecycle: fixture.lifecycle,
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
  async (context) => {
    const fixture = await createFixture("streaming-nonblocking", context);
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
          atomicMemoryLifecycle: fixture.lifecycle,
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
      assert.equal(extractionCalls, 0, "foreground returns before idle extraction starts");
      fixture.advanceIdle(29_999);
      assert.equal(extractionCalls, 0);
      fixture.advanceIdle(1);
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

test("atomic extraction failure cannot replace foreground terminal success", async (context) => {
  const fixture = await createFixture("extraction-failure", context);
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
        atomicMemoryLifecycle: fixture.lifecycle,
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

test("default priced atomic extraction accounts memory_review separately from main physical requests", async (context) => {
  const fixture = await createFixture("priced-worker", context);
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-priced-worker";
  let providerInstances = 0,
    generateCalls = 0;
  const providerFactory: RunAgentProviderFactory = () => {
    providerInstances++;
    return physicalProviderFixture(
      {
        async generate(messages, tools) {
          const extractionIndex = messages.findLastIndex(
            (message) =>
              message.content.includes("<memory_evidence>") ||
              message.content.includes("<user_evidence_candidates>"),
          );
          const extractionPrompt = messages[extractionIndex]?.content ?? "";
          if (
            extractionPrompt.includes("<memory_evidence>") ||
            extractionPrompt.includes("<user_evidence_candidates>")
          ) {
            return {
              role: "assistant",
              content: successfulExtraction(
                extractionPrompt,
                "npm run priced-review",
                messages.slice(0, extractionIndex),
              ),
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
      },
      "quality-priced-model",
    );
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
        atomicMemoryLifecycle: fixture.lifecycle,
        providerFactory,
        reporter: new SilentReporter(),
      },
    );
    const session = globalSessionManager.get(sessionId, fixture.workspace, {
      picoHome: fixture.picoHome,
    });
    assert.ok(session);
    await drainExtraction(fixture, sessionId);
    await waitForProviderCalls(fixture, 4);
    const usageAfterExtraction = session.getRuntimeStateSnapshot().usage;
    assert.equal(usageAfterExtraction.totalProviderCalls, 4);
    assert.equal(usageAfterExtraction.totalPromptTokens, 280);
    assert.equal(usageAfterExtraction.totalCompletionTokens, 140);
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
      const calls = ledger.listAccountingProviderCalls();
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

function successfulExtraction(
  prompt: string,
  content: string,
  messages: readonly Message[] = [],
): string {
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
  const evidence = JSON.parse(payload) as {
    sourceRef: string;
    texts?: string[];
    messagePositions?: number[];
  }[];
  const source = evidence.find((entry) =>
    (
      entry.messagePositions?.map((position) => messages[position]?.content ?? "") ??
      entry.texts ??
      []
    ).some((text) => text.includes(content)),
  );
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
  // Idle expiry starts snapshot preparation before the session lane is entered.
  // Drain that lifecycle work first, then observe a final lane barrier.
  fixture.advanceIdle();
  await fixture.lifecycle.drain();
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
      if (ledger.listAccountingProviderCalls().length === expected) return;
    } finally {
      ledger.close();
    }
    await new Promise((resolve) => setImmediate(resolve));
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
  readonly lifecycle: DrainableMemoryLifecycle;
  readonly advanceIdle: (milliseconds?: number) => void;
}

async function createFixture(name: string, context: TestContext): Promise<RuntimeFixture> {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const lifecycle = new DrainableMemoryLifecycle();
  context.after(async () => {
    await lifecycle.close();
    context.mock.timers.reset();
  });
  const root = await mkdtemp(join(tmpdir(), `pico-memory-runtime-quality-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  return {
    root,
    workspace,
    picoHome,
    lifecycle,
    advanceIdle: (milliseconds = 30_000) => context.mock.timers.tick(milliseconds),
  };
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
