import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { sessionMemoryLane } from "@pico/runtime/atomic-memory/session-lane";
import {
  memorySessionKey,
  type MemoryModelRequest,
} from "@pico/core/atomic-memory-runtime-contracts";
import { executeAgentRuntime, type AgentRuntimeDependencies } from "@pico/pico-host/agent-runtime";
import { AtomicMemoryRuntime } from "@pico/pico-host/atomic-memory-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";

const fact = "I prefer concise Chinese answers.";
const item = {
  content: fact,
  kind: "preference",
  statementType: "fact",
  temporalType: "undated",
  eventStartedAt: null,
  eventEndedAt: null,
  scope: "global",
  keys: [{ key: "Chinese", type: "concept" }],
};
const emptyProposal = JSON.stringify({
  status: "complete",
  coverageStatus: "processed",
  requestedStatus: "not_applicable",
  requestedItems: [],
  incidentalItems: [],
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-auto-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "auto";
  await mkdir(workDir);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const paths = resolvePicoPaths(workDir, { picoHome });
  const sessionKey = memorySessionKey(paths.workspace.id, sessionId);
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  let runs = 0;
  const requests: MemoryModelRequest[] = [];
  const dependencies: AgentRuntimeDependencies = {
    picoHome,
    memoryTrustStore: trust,
    reporter: new SilentReporter(),
    provider: {
      async generate() {
        return { role: "assistant", content: "Received." };
      },
    },
    atomicMemoryModelFactory: async () => ({
      model: {
        async call(request) {
          requests.push(structuredClone(request));
          return emptyProposal;
        },
      },
    }),
  };
  const drain = () =>
    sessionMemoryLane.run(`${picoHome}:${sessionKey}`, "background", async () => undefined);
  t.after(async () => {
    await drain();
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    workDir,
    picoHome,
    sessionId,
    paths,
    sessionKey,
    store,
    events,
    requests,
    dependencies,
    drain,
    async autoExtract(value: boolean) {
      const settings = await store.readSettings(paths.workspace.id);
      await store.updateSettings({
        workspaceKey: paths.workspace.id,
        expectedVersion: settings.version,
        autoExtract: value,
      });
    },
    async run(
      prompt: string,
      input: { allowedTools?: string[]; dependencies?: AgentRuntimeDependencies } = {},
    ) {
      await executeAgentRuntime(
        {
          prompt,
          dir: workDir,
          provider: "openai",
          modelRouteId: "test/test",
          sessionSelection: { mode: runs++ === 0 ? "new" : "resume", sessionId },
          ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        },
        { ...dependencies, ...input.dependencies },
      );
      await drain();
      const entries = await events.readSessionEntries(sessionId);
      const terminal = entries.filter((entry) => entry.event.kind === "run.terminal").at(-1)!;
      assert.equal(terminal.event.kind, "run.terminal");
      return terminal;
    },
  };
}

test("ordinary completion automatically persists memory without memory_extract and repeated dispatch stays idempotent", async (t) => {
  const f = await fixture(t);
  const terminal = await f.run(fact, {
    dependencies: {
      atomicMemoryModelFactory: async () => ({
        model: {
          async call(request) {
            f.requests.push(structuredClone(request));
            if (request.stage === "canonicalize")
              return JSON.stringify({
                results: [{ candidateId: "candidate_0", status: "accepted", item }],
              });
            const evidence = JSON.parse(
              request.prompt.match(/<memory_evidence>\n([\s\S]*?)\n<\/memory_evidence>/u)![1]!,
            ) as Array<{ sourceRef: string; messagePositions: number[] }>;
            const source = evidence.find((entry) =>
              entry.messagePositions.some((position) =>
                request.sourceMessages?.[position]?.content.includes(fact),
              ),
            )!;
            return JSON.stringify({
              status: "complete",
              coverageStatus: "processed",
              requestedStatus: "not_applicable",
              requestedItems: [],
              incidentalItems: [
                { ...item, evidence: [{ sourceRef: source.sourceRef, quote: fact }] },
              ],
            });
          },
        },
      }),
    },
  });
  assert.equal(f.requests.length, 2);
  assert.equal((await f.store.listItems({ workspaceKey: f.paths.workspace.id })).length, 1);
  assert.equal(
    (await f.store.readExtractionCursor(f.sessionKey))?.processedOrdinal,
    terminal.sequence,
  );
  assert.ok(
    !(await f.events.readSessionEntries(f.sessionId)).some(
      (entry) => entry.event.kind === "tool.started",
    ),
  );
  assert.equal(
    terminal.event.kind === "run.terminal" &&
      terminal.event.data.memoryExtractionBoundary?.disposition,
    "eligible",
  );
  const runtime = new AtomicMemoryRuntime({
    workDir: f.workDir,
    picoHome: f.picoHome,
    sessionId: f.sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: f.dependencies.atomicMemoryModelFactory!,
  });
  await runtime.requestExtract();
  await runtime.completed(terminal.event.runId);
  await runtime.completed(terminal.event.runId);
  await runtime.drain();
  assert.equal(f.requests.length, 2);
});

for (const scenario of ["disabled", "tools_denied", "settings_changed", "deleted"] as const) {
  test(`automatic extraction never backfills a prior ${scenario} run`, async (t) => {
    const f = await fixture(t);
    if (scenario === "disabled") await f.autoExtract(false);
    const before = await f.store.readSettings(f.paths.workspace.id);
    const revision = await f.store.readDeletionRevision();
    const prior = await f.run("My previous project uses Rust.", {
      ...(scenario === "tools_denied" ? { allowedTools: [] } : {}),
      dependencies: {
        provider: {
          async generate() {
            if (scenario === "settings_changed") {
              await f.autoExtract(false);
              await f.autoExtract(true);
            }
            if (scenario === "deleted") {
              const written = await f.store.applyMutations({
                operationId: "deletion-seed",
                mutations: [
                  {
                    type: "create",
                    item: {
                      content: "A temporary note.",
                      kind: "knowledge",
                      statementType: "fact",
                      temporalType: "undated",
                      scopeType: "workspace",
                      scopeKey: f.paths.workspace.id,
                      observedAt: Date.now(),
                      origin: "user_requested",
                      keys: [{ key: "note", keyType: "concept", keyOrigin: "user" }],
                      sources: [],
                    },
                  },
                ],
              });
              await f.store.deleteItem({
                itemId: written.results[0]!.itemId,
                expectedVersion: 1,
                operationId: "delete-during-run",
              });
            }
            return { role: "assistant", content: "Received." };
          },
        },
      },
    });
    assert.equal(f.requests.length, 0);
    assert.equal(
      prior.event.kind === "run.terminal" && prior.event.data.memoryExtractionBoundary?.disposition,
      "policy_denied",
    );
    if (prior.event.kind === "run.terminal") {
      assert.equal(prior.event.data.memoryExtractionBoundary?.settingsVersion, before.version);
      assert.equal(prior.event.data.memoryExtractionBoundary?.deletionRevision, revision);
    }
    if (scenario === "disabled") await f.autoExtract(true);
    const current = await f.run(fact);
    assert.equal(f.requests.length, 1);
    const oldUser = (await f.events.readSessionEntries(f.sessionId)).find(
      (entry) =>
        entry.event.kind === "message.committed" &&
        entry.event.data.message.content === "My previous project uses Rust.",
    )!;
    assert.ok(
      !f.requests[0]!.prompt.includes(`event:${oldUser.event.eventId}`),
      "the admitted evidence cannot include a denied run",
    );
    assert.equal(
      (await f.store.readExtractionCursor(f.sessionKey))?.processedOrdinal,
      current.sequence,
    );
  });
}

test("an eligible terminal left during shutdown survives a denied Run and recovers before the next automatic tail", async (t) => {
  const f = await fixture(t);
  const lifecycle = new AtomicMemoryLifecycle();
  lifecycle.beginDrain();
  const prior = await f.run("My previous project uses Rust.", {
    dependencies: { atomicMemoryLifecycle: lifecycle },
  });
  await lifecycle.close();
  assert.equal(f.requests.length, 0);
  assert.equal(
    prior.event.kind === "run.terminal" && prior.event.data.memoryExtractionBoundary?.disposition,
    "eligible",
  );
  await f.run("A restricted intermediate conversation.", { allowedTools: [] });
  assert.equal(f.requests.length, 0);
  assert.equal(
    await f.store.readExtractionCursor(f.sessionKey),
    undefined,
    "live refusal cannot advance over the earlier eligible boundary",
  );
  const current = await f.run(fact);
  assert.equal(f.requests.length, 2, "recovery and the new tail each use their own boundary");
  assert.match(JSON.stringify(f.requests[0]!.sourceMessages), /previous project uses Rust/);
  assert.doesNotMatch(JSON.stringify(f.requests[0]!.sourceMessages), /concise Chinese/);
  const restrictedInput = (await f.events.readSessionEntries(f.sessionId)).find(
    (entry) =>
      entry.event.kind === "message.committed" &&
      entry.event.data.message.content === "A restricted intermediate conversation.",
  )!;
  assert.ok(!f.requests[1]!.prompt.includes(`event:${restrictedInput.event.eventId}`));
  assert.equal(
    (await f.store.readExtractionCursor(f.sessionKey))?.processedOrdinal,
    current.sequence,
  );
});

test("a denied automatic completion cannot advance across a pending explicit remember", async (t) => {
  const f = await fixture(t);
  const lifecycle = new AtomicMemoryLifecycle();
  let calls = 0;
  await f.run(`Please remember: ${fact}`, {
    allowedTools: ["memory_remember", "memory_extract"],
    dependencies: {
      atomicMemoryLifecycle: lifecycle,
      atomicMemoryModelFactory: async () => ({
        model: {
          async call() {
            return "malformed";
          },
        },
      }),
      provider: {
        async generate() {
          if (calls++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "remember", name: "memory_remember", arguments: "{}" }],
            };
          lifecycle.beginDrain();
          return { role: "assistant", content: "Received." };
        },
      },
    },
  });
  await lifecycle.close();
  const pending = await f.store.readPendingExtractionFailure(f.sessionKey);
  assert.equal(pending?.firstTrigger, "remember");
  await f.autoExtract(false);
  await f.run("Continue.");
  assert.deepEqual(await f.store.readPendingExtractionFailure(f.sessionKey), pending);
  assert.equal(await f.store.readExtractionCursor(f.sessionKey), undefined);
  assert.equal(f.requests.length, 0);
});
