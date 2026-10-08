import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  isMemoryRecallTrace,
  LLMStatusError,
  type ProviderAttemptLifecycleSnapshot,
  type LLMProviderRequestOptions,
  type Message,
} from "@pico/core";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import {
  MemoryRecallRequestTracker,
  memoryRecallTextHash,
  capturePreparedMemoryRecall,
  AtomicMemoryLifecycle,
} from "@pico/runtime";
import { CostTracker } from "@pico/runtime/cost-tracker";
import { generateWithRetry } from "@pico/runtime/provider-retry";
import { parsePreparedRequestCapture } from "@pico/runtime/provider-request-diagnostics";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime, type AgentRuntimeDependencies } from "@pico/pico-host/agent-runtime";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-recall-trace-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "recall-trace";
  await mkdir(workDir);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: paths.workspace.root });
  const lifecycle = new AtomicMemoryLifecycle();
  t.after(async () => {
    await lifecycle.close();
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    ledger.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const seed = await store.applyMutations({
    operationId: "seed",
    mutations: [
      {
        type: "create",
        item: {
          content: "TraceAnchor remembers BodySecret731.",
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: paths.workspace.id,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "TraceAnchor", keyType: "concept", keyOrigin: "user" }],
          sources: [
            {
              sessionId: "source-session",
              runId: "source-run",
              turnId: "source-turn",
              eventId: "source-user",
            },
          ],
        },
      },
    ],
  });
  return {
    workDir,
    picoHome,
    sessionId,
    trust,
    paths,
    store,
    events,
    ledger,
    lifecycle,
    itemId: seed.results[0]!.itemId,
  };
}

test("recall metadata is bounded without changing selection, query/body snapshots or preview writes", async (t) => {
  const f = await fixture(t);
  const source = "x".repeat(400);
  const mutations = Array.from({ length: 35 }, (_, i) => ({
    type: "create" as const,
    item: {
      content: `TraceAnchor fact ${i}.`,
      kind: "knowledge" as const,
      statementType: "fact" as const,
      temporalType: "undated" as const,
      scopeType: "workspace" as const,
      scopeKey: f.paths.workspace.id,
      observedAt: i + 2,
      origin: "user_requested" as const,
      keys: [{ key: "TraceAnchor", keyType: "concept" as const, keyOrigin: "user" as const }],
      sources: Array.from({ length: 5 }, (_, j) => ({
        sessionId: `${source}${j}`,
        runId: source,
        turnId: source,
        eventId: `${source}${j}`,
      })),
    },
  }));
  for (const offset of [0, 32])
    await f.store.applyMutations({
      operationId: `more-${offset}`,
      mutations: mutations.slice(offset, offset + 32),
    });
  const builder = new AtomicMemoryContextBuilder(f.store, f.paths.workspace.id);
  const query = "TraceAnchor QuerySecret952";
  const preview = await builder.build(query, { mode: "search" });
  assert.equal(preview.trace, undefined);
  const result = await builder.build(query, {
    mode: "search",
    trace: { queryRef: { toolCallId: "search-call" } },
  });
  assert.equal(result.block, preview.block);
  assert.deepEqual(result.items, preview.items);
  assert.deepEqual(result.references, preview.references);
  const trace = result.trace!;
  assert.ok(isMemoryRecallTrace(trace));
  assert.equal(trace.selected.length, 10);
  assert.equal(trace.counts.item_limit, 26);
  assert.ok(trace.diagnostics.length <= 24);
  assert.ok(trace.selected.every((item) => item.sources.length <= 3 && item.sourceCount === 5));
  assert.ok(trace.traceTruncated);
  assert.ok(trace.omittedSourceCount > 0);
  assert.equal(trace.omittedDiagnosticCount + trace.diagnostics.length, 26);
  const serialized = JSON.stringify(trace);
  assert.ok(Buffer.byteLength(serialized) <= 8192);
  assert.doesNotMatch(serialized, /TraceAnchor|QuerySecret952|BodySecret731/);
  assert.equal(trace.queryHash, memoryRecallTextHash(query));
  assert.equal(trace.blockHash, memoryRecallTextHash(result.block));
  assert.deepEqual(
    trace.selected.map((item) => [item.itemId, item.itemVersion, item.contentHash, item.range]),
    result.items.map((record, index) => [
      record.item.itemId,
      record.item.version,
      record.item.contentHash,
      result.references[index]!.range,
    ]),
  );
  const exhausted = await builder.build(query, { mode: "search", maxTokens: 1, trace: {} });
  assert.equal(exhausted.trace?.outcome, "budget_exhausted");
  assert.equal(exhausted.trace?.counts.budget, 36);
  assert.equal(exhausted.trace?.selected.length, 0);
  assert.equal((await f.events.readSessionEntries(f.sessionId)).length, 0);
  const tracker = new MemoryRecallRequestTracker({
    record: async () => "recall-event",
    readHistory: async () => [{ eventId: "history-event", trace }],
  });
  const messages: Message[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "search-call", name: "memory_search", arguments: "{}" }],
    },
    { role: "user", toolCallId: "search-call", content: result.block },
  ];
  const facts = await tracker.context(messages);
  assert.equal(facts.recalls[0]?.recallEventId, "history-event");
  assert.equal((await tracker.context([])).recalls.length, 0);
  for (const provider of ["openai", "claude", "responses"] as const) {
    const body =
      provider === "responses"
        ? { input: [{ type: "function_call_output", output: result.block }] }
        : { messages: [{ role: "user", content: [{ type: "text", text: result.block }] }] };
    const diagnostic = capturePreparedMemoryRecall({ provider, model: "test", body }, facts);
    assert.ok(diagnostic.recalls[0]?.blockPresent);
    assert.ok(diagnostic.recalls[0]?.references.every((reference) => reference.present));
    const modified = capturePreparedMemoryRecall(
      {
        provider,
        model: "test",
        body: {
          ...body,
          [provider === "responses" ? "input" : "messages"]: [
            {
              content: result.block.replace("TraceAnchor", "ChangedAnchor"),
              output: result.block.replace("TraceAnchor", "ChangedAnchor"),
            },
          ],
        },
      },
      facts,
    );
    assert.equal(modified.recalls[0]?.blockPresent, false);
    assert.equal(
      modified.recalls[0]?.references.filter((reference) => !reference.present).length,
      1,
    );
    const partialWrapper = capturePreparedMemoryRecall(
      {
        provider,
        model: "test",
        body:
          provider === "responses"
            ? { input: [{ output: result.block.replace("</atomic-memory-reference>", "") }] }
            : { messages: [{ content: result.block.replace("</atomic-memory-reference>", "") }] },
      },
      facts,
    );
    assert.equal(partialWrapper.recalls[0]?.blockPresent, false);
    assert.ok(partialWrapper.recalls[0]?.references.every((reference) => reference.present));
  }
});

test("Host persists automatic/search identity, links actual requests and restores tool history on resume", async (t) => {
  const f = await fixture(t);
  const observedFacts: Array<NonNullable<LLMProviderRequestOptions["contextFacts"]>> = [];
  let calls = 0;
  const dependencies: AgentRuntimeDependencies = {
    picoHome: f.picoHome,
    memoryTrustStore: f.trust,
    atomicMemoryLifecycle: f.lifecycle,
    reporter: new SilentReporter(),
    provider: {
      async generate(messages, _tools, options) {
        observedFacts.push(structuredClone(options!.contextFacts!));
        options?.onRequestPrepared?.({ provider: "openai", model: "test", body: { messages } });
        await reportFixtureAttempt(options, "openai", "test", {
          promptTokens: 1,
          completionTokens: 1,
        });
        if (calls++ === 0)
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "search-call", name: "memory_search", arguments: '{"query":"TraceAnchor"}' },
            ],
          };
        return { role: "assistant", content: "Done." };
      },
    },
  };
  const run = async (mode: "new" | "resume", prompt: string) =>
    executeAgentRuntime(
      {
        prompt,
        dir: f.workDir,
        sessionSelection: { mode, sessionId: f.sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        allowedTools: ["memory_search"],
      },
      dependencies,
    );
  await run("new", "TraceAnchor QuerySecret952");
  await globalSessionManager.delete(f.sessionId, f.workDir, { picoHome: f.picoHome })?.close();
  await run("resume", "No matching fact");
  const entries = await f.events.readSessionEntries(f.sessionId);
  const recalls = entries.flatMap(({ event }) =>
    event.kind === "memory.recall.recorded" ? [event] : [],
  );
  assert.ok(recalls.length >= 3);
  const selectedAuto = recalls.find(
    (event) => event.data.mode === "automatic" && event.data.outcome === "selected",
  )!;
  const search = recalls.find((event) => event.data.mode === "search")!;
  assert.equal(selectedAuto.data.selected[0]?.itemId, f.itemId);
  assert.equal(search.data.queryRef?.toolCallId, "search-call");
  assert.ok(
    entries.some(
      ({ event }) =>
        event.eventId === selectedAuto.data.queryRef?.eventId &&
        event.kind === "message.committed" &&
        event.data.message.role === "user" &&
        !event.data.message.toolCallId,
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(recalls.map((event) => event.data)),
    /TraceAnchor|QuerySecret952|BodySecret731/,
  );
  assert.ok(
    observedFacts[1]?.memoryRecall?.recalls.some(
      (recall) => recall.recallEventId === search.eventId,
    ),
  );
  assert.ok(
    observedFacts
      .at(-1)
      ?.memoryRecall?.recalls.some((recall) => recall.recallEventId === search.eventId),
  );
  const noHits = recalls.find((event) => event.data.outcome === "no_hits")!;
  assert.ok(
    observedFacts
      .at(-1)
      ?.memoryRecall?.recalls.some((recall) => recall.recallEventId === noHits.eventId),
  );
  const attempts = f.ledger.listPhysicalAttempts({ sessionId: f.sessionId });
  assert.equal(attempts.length, 3);
  for (const attempt of attempts) {
    const diagnostic = attempt.requestDiagnostic?.["memoryRecall"] as {
      recalls: Array<{ blockPresent?: boolean; references: Array<{ present: boolean }> }>;
    };
    assert.ok(diagnostic);
    assert.ok(
      diagnostic.recalls.every(
        (recall) =>
          recall.blockPresent !== false &&
          recall.references.every((reference) => reference.present),
      ),
    );
    assert.doesNotMatch(JSON.stringify(diagnostic), /TraceAnchor|QuerySecret952|BodySecret731/);
  }
  const started = entries.flatMap(({ event }) =>
    event.kind === "model.call.started" ? [event] : [],
  );
  assert.ok(started.some((event) => event.data.recallEventIds?.includes(search.eventId)));
});

test("Host records disabled/admission/error outcomes and trace write failure never retries model work", async (t) => {
  for (const profile of ["disabled", "admission", "error", "write-failure"] as const)
    await t.test(profile, async (t) => {
      const f = await fixture(t);
      const settings = await f.store.readSettings(f.paths.workspace.id);
      if (profile === "disabled")
        await f.store.updateSettings({
          workspaceKey: f.paths.workspace.id,
          expectedVersion: settings.version,
          recallEnabled: false,
        });
      if (profile === "admission")
        await f.trust.setTrusted(await f.trust.canonicalize(f.workDir), false);
      const originalBuild = AtomicMemoryContextBuilder.prototype.build;
      const originalRecord = RuntimeRun.prototype.recordRecall;
      if (profile === "error")
        AtomicMemoryContextBuilder.prototype.build = async () => {
          throw new Error("local fixture failure");
        };
      if (profile === "write-failure")
        RuntimeRun.prototype.recordRecall = async () => {
          throw new Error("trace storage failure");
        };
      t.after(() => {
        AtomicMemoryContextBuilder.prototype.build = originalBuild;
        RuntimeRun.prototype.recordRecall = originalRecord;
      });
      let calls = 0;
      let coverage: string | undefined;
      await executeAgentRuntime(
        {
          prompt: "TraceAnchor",
          dir: f.workDir,
          sessionSelection: { mode: "new", sessionId: f.sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          allowedTools: profile === "admission" ? [] : ["memory_search"],
        },
        {
          picoHome: f.picoHome,
          memoryTrustStore: f.trust,
          atomicMemoryLifecycle: f.lifecycle,
          reporter: new SilentReporter(),
          provider: {
            async generate(_messages, _tools, options) {
              calls++;
              coverage = options?.contextFacts?.memoryRecall?.coverage;
              return { role: "assistant", content: "Done." };
            },
          },
        },
      );
      assert.equal(calls, 1);
      const recalls = (await f.events.readSessionEntries(f.sessionId)).flatMap(({ event }) =>
        event.kind === "memory.recall.recorded" ? [event.data] : [],
      );
      if (profile === "write-failure") {
        assert.equal(recalls.length, 0);
        assert.equal(coverage, "unrecorded");
      } else {
        assert.equal(recalls[0]?.outcome, profile === "admission" ? "admission_denied" : profile);
        assert.equal(coverage, "recorded");
      }
    });
});

test("retry and cancelled attempts preserve frozen recall identities and prepared/observed facts", async (t) => {
  const f = await fixture(t);
  const result = await new AtomicMemoryContextBuilder(f.store, f.paths.workspace.id).build(
    "TraceAnchor",
    { trace: {} },
  );
  let eventId = "frozen-recall";
  const recalls = new MemoryRecallRequestTracker({ record: async () => eventId });
  await recalls.record(result.trace!);
  const facts = await recalls.context([]);
  let calls = 0;
  const snapshots: Array<NonNullable<LLMProviderRequestOptions["contextFacts"]>> = [];
  const tracked = new CostTracker(
    {
      modelName: "test",
      requestCapabilities: { physicalAttempts: true, toolChoiceNoneWithTools: true },
      async generate(_messages, _tools, options) {
        calls++;
        snapshots.push(structuredClone(options!.contextFacts!));
        const body = {
          messages: [
            {
              role: "user",
              content:
                calls === 1 ? result.block : result.block.replace("BodySecret731", "ChangedBody"),
            },
          ],
        };
        options?.onRequestPrepared?.({ provider: "openai", model: "test", body });
        const attempt: ProviderAttemptLifecycleSnapshot = {
          physicalAttemptId: `retry-${calls}`,
          revision: 0,
          attempt: 0,
          provider: "openai",
          model: "test",
          startedAt: new Date().toISOString(),
          status: "prepared",
          usageBasis: "missing",
        };
        await options?.onProviderAttemptStart?.(attempt);
        if (calls === 1) {
          // A settings/memory change during the retry delay cannot reselect the logical call.
          eventId = "later-recall";
          await recalls.record(result.trace!);
          await options?.onProviderAttemptUpdate?.({
            ...attempt,
            revision: 1,
            status: "failed",
            completedAt: new Date().toISOString(),
          });
          throw new LLMStatusError(503, "retry fixture");
        }
        await options?.onProviderAttemptUpdate?.({ ...attempt, revision: 1, status: "observed" });
        await options?.onProviderAttemptUpdate?.({
          ...attempt,
          revision: 2,
          status: "succeeded",
          usageBasis: "reported",
          usage: { promptTokens: 1, completionTokens: 1 },
          completedAt: new Date().toISOString(),
        });
        return {
          role: "assistant",
          content: "Done.",
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    },
    { provider: "openai", model: "test" },
    undefined,
    { ledger: f.ledger, context: { purpose: "main", sessionId: f.sessionId } },
  );
  await generateWithRetry(tracked, [], [], {
    maxAttempts: 2,
    contextFacts: { version: 1, memoryRecall: facts },
  });
  assert.equal(calls, 2);
  assert.deepEqual(snapshots[0]?.memoryRecall, snapshots[1]?.memoryRecall);
  assert.equal(snapshots[1]?.memoryRecall?.recalls[0]?.recallEventId, "frozen-recall");
  const attempts = f.ledger.listPhysicalAttempts({ sessionId: f.sessionId });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.logicalCallId, attempts[1]?.logicalCallId);
  assert.deepEqual(
    attempts.map((attempt) => attempt.retryAttempt),
    [0, 1],
  );
  const captures = attempts.map((attempt) =>
    parsePreparedRequestCapture(attempt.requestDiagnostic),
  );
  assert.equal(captures[0]?.memoryRecall?.recalls[0]?.references[0]?.present, true);
  assert.equal(captures[1]?.memoryRecall?.recalls[0]?.references[0]?.present, false);
  const abort = new AbortController();
  const cancelled = new CostTracker(
    {
      modelName: "test",
      requestCapabilities: { physicalAttempts: true, toolChoiceNoneWithTools: true },
      async generate(_messages, _tools, options) {
        options?.onRequestPrepared?.({
          provider: "openai",
          model: "test",
          body: { messages: [{ role: "user", content: result.block }] },
        });
        const attempt: ProviderAttemptLifecycleSnapshot = {
          physicalAttemptId: "cancelled-before-observation",
          revision: 0,
          attempt: 0,
          provider: "openai",
          model: "test",
          startedAt: new Date().toISOString(),
          status: "prepared",
          usageBasis: "missing",
        };
        await options?.onProviderAttemptStart?.(attempt);
        abort.abort();
        await options?.onProviderAttemptUpdate?.({
          ...attempt,
          revision: 1,
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        throw new DOMException("cancelled fixture", "AbortError");
      },
    },
    { provider: "openai", model: "test" },
    undefined,
    { ledger: f.ledger, context: { purpose: "main", sessionId: f.sessionId } },
  );
  await assert.rejects(
    cancelled.generate([], [], {
      signal: abort.signal,
      contextFacts: { version: 1, memoryRecall: facts },
    }),
    /cancelled fixture/,
  );
  const cancellation = f.ledger
    .listPhysicalAttempts({ sessionId: f.sessionId })
    .find((attempt) => attempt.physicalAttemptId === "cancelled-before-observation")!;
  assert.equal(cancellation.status, "cancelled");
  assert.equal(cancellation.timeToFirstTokenMs, undefined);
  assert.equal(
    parsePreparedRequestCapture(cancellation.requestDiagnostic)?.memoryRecall?.recalls[0]
      ?.references[0]?.present,
    true,
  );
  assert.doesNotMatch(JSON.stringify(cancellation.requestDiagnostic), /TraceAnchor|BodySecret731/);
});

test("active search records changed admission and disabled outcomes without returning memory", async (t) => {
  for (const profile of ["disabled", "admission_denied"] as const)
    await t.test(profile, async (t) => {
      const f = await fixture(t);
      let calls = 0;
      let output = "";
      await executeAgentRuntime(
        {
          prompt: "TraceAnchor",
          dir: f.workDir,
          sessionSelection: { mode: "new", sessionId: f.sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          allowedTools: ["memory_search"],
        },
        {
          picoHome: f.picoHome,
          memoryTrustStore: f.trust,
          atomicMemoryLifecycle: f.lifecycle,
          reporter: new SilentReporter(),
          provider: {
            async generate(messages) {
              if (calls++ === 0) {
                if (profile === "disabled") {
                  const settings = await f.store.readSettings(f.paths.workspace.id);
                  await f.store.updateSettings({
                    workspaceKey: f.paths.workspace.id,
                    expectedVersion: settings.version,
                    recallEnabled: false,
                  });
                } else await f.trust.setTrusted(await f.trust.canonicalize(f.workDir), false);
                return {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    {
                      id: "denied-search",
                      name: "memory_search",
                      arguments: '{"query":"TraceAnchor"}',
                    },
                  ],
                };
              }
              output = messages
                .filter((message) => message.toolCallId === "denied-search")
                .map((message) => message.content)
                .join("\n");
              return { role: "assistant", content: "Done." };
            },
          },
        },
      );
      assert.match(output, /Memory search unavailable/);
      assert.doesNotMatch(output, /BodySecret731/);
      const search = (await f.events.readSessionEntries(f.sessionId)).flatMap(({ event }) =>
        event.kind === "memory.recall.recorded" && event.data.mode === "search" ? [event.data] : [],
      )[0]!;
      assert.equal(search.outcome, profile);
      assert.equal(search.queryRef?.toolCallId, "denied-search");
      assert.equal(search.selected.length, 0);
    });
});

test("cross-Run reused tool IDs match actual history text, preserve reuse and refuse ambiguous carriers", async (t) => {
  const f = await fixture(t);
  const requests: Message[][] = [];
  let calls = 0;
  const dependencies: AgentRuntimeDependencies = {
    picoHome: f.picoHome,
    memoryTrustStore: f.trust,
    atomicMemoryLifecycle: f.lifecycle,
    reporter: new SilentReporter(),
    provider: {
      async generate(messages, _tools, options) {
        requests.push(structuredClone(messages));
        options?.onRequestPrepared?.({ provider: "openai", model: "test", body: { messages } });
        await reportFixtureAttempt(options, "openai", "test", {
          promptTokens: 1,
          completionTokens: 1,
        });
        if (calls++ % 2 === 0)
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_0", name: "memory_search", arguments: '{"query":"TraceAnchor"}' },
            ],
          };
        return { role: "assistant", content: "Done." };
      },
    },
  };
  const run = (mode: "new" | "resume") =>
    executeAgentRuntime(
      {
        prompt: "TraceAnchor",
        dir: f.workDir,
        sessionSelection: { mode, sessionId: f.sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        allowedTools: ["memory_search"],
      },
      dependencies,
    );
  const history = async () =>
    (
      await f.events.readSessionEntriesOfKinds(f.sessionId, ["memory.recall.recorded"])
    ).entries.flatMap(({ event }) =>
      event.kind === "memory.recall.recorded" && event.data.mode === "search"
        ? [{ eventId: event.eventId, trace: event.data }]
        : [],
    );
  await run("new");
  const oldRequest = requests[1]!;
  await f.store.applyMutations({
    operationId: "later-fact",
    mutations: [
      {
        type: "create",
        item: {
          content: "TraceAnchor gained NewBody928.",
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: f.paths.workspace.id,
          observedAt: 2,
          origin: "user_requested",
          keys: [{ key: "TraceAnchor", keyType: "concept", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  await run("resume");
  const [oldRecall, newRecall] = await history();
  assert.ok(oldRecall && newRecall);
  assert.notEqual(oldRecall.trace.blockHash, newRecall.trace.blockHash);
  assert.doesNotMatch(JSON.stringify(oldRequest), /NewBody928/);
  // Both persisted traces are real, differently scoped Runs sharing the provider's tool ID.
  const tracker = new MemoryRecallRequestTracker({
    record: async () => undefined,
    readHistory: history,
  });
  const oldFacts = await tracker.context(oldRequest);
  assert.equal(oldFacts.coverage, "recorded");
  assert.deepEqual(
    oldFacts.recalls.map((recall) => recall.recallEventId),
    [oldRecall.eventId],
  );
  assert.deepEqual(
    await tracker.context(oldRequest),
    oldFacts,
    "one historical carrier can be reused in later requests",
  );
  const prepared = capturePreparedMemoryRecall(
    { provider: "openai", model: "test", body: { messages: oldRequest } },
    oldFacts,
  );
  assert.equal(prepared.recalls[0]?.blockPresent, true);
  assert.ok(prepared.recalls[0]?.references.every((reference) => reference.present));
  const freshTracker = new MemoryRecallRequestTracker({
    record: async () => newRecall.eventId,
    readHistory: async () => [oldRecall],
  });
  await freshTracker.context(oldRequest);
  await freshTracker.record(newRecall.trace);
  assert.deepEqual(
    (await freshTracker.context(oldRequest)).recalls.map((recall) => recall.recallEventId),
    [oldRecall.eventId],
    "fresh records cannot overwrite older carriers",
  );
  const bothFacts = await tracker.context(requests[3]!);
  assert.deepEqual(
    new Set(bothFacts.recalls.map((recall) => recall.recallEventId)),
    new Set([oldRecall.eventId, newRecall.eventId]),
  );
  // A third Run retrieved exactly the same bytes as the second; hashes cannot identify which event owns that carrier.
  await run("resume");
  const ambiguous = await new MemoryRecallRequestTracker({
    record: async () => undefined,
    readHistory: history,
  }).context(requests[3]!);
  assert.equal(ambiguous.coverage, "unrecorded");
  assert.deepEqual(
    ambiguous.recalls.map((recall) => recall.recallEventId),
    [oldRecall.eventId],
  );
  const empty = await new AtomicMemoryContextBuilder(f.store, f.paths.workspace.id).build(
    "NoHitAnchor432",
    { mode: "search", trace: { queryRef: { toolCallId: "empty-call" } } },
  );
  assert.equal(empty.trace?.outcome, "no_hits");
  let emptyId = "empty-a";
  const emptyTracker = new MemoryRecallRequestTracker({ record: async () => emptyId });
  await emptyTracker.record(empty.trace!);
  emptyId = "empty-b";
  await emptyTracker.record(empty.trace!);
  const emptyFacts = await emptyTracker.context([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "empty-call", name: "memory_search", arguments: "{}" }],
    },
    {
      role: "user",
      toolCallId: "empty-call",
      content:
        '<atomic-memory-reference trust="low">No matching active memory.</atomic-memory-reference>',
    },
  ]);
  assert.equal(emptyFacts.coverage, "unrecorded");
  assert.deepEqual(emptyFacts.recalls, []);
});
