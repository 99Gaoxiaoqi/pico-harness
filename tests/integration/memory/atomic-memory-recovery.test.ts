import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FullCompactor } from "../../../src/context/full-compactor.js";
import { recordRuntimeCompactionCheckpoint } from "../../../src/context/runtime-compaction-checkpoint.js";
import { Session } from "../../../src/engine/session.js";
import {
  memorySessionKey,
  type MemoryModelRequest,
} from "../../../src/memory/atomic/runtime-contracts.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { AtomicMemoryRuntime } from "../../../src/runtime/atomic-memory-runtime.js";
import { RuntimeRun } from "../../../src/runtime/runtime-run.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";

const oldFact = "My previous project uses Rust.";
const newFact = "I prefer concise Chinese answers.";
const newPrompt = `Please remember: ${newFact}`;
const requestedItem = {
  content: newFact,
  kind: "preference",
  statementType: "fact",
  temporalType: "undated",
  eventStartedAt: null,
  eventEndedAt: null,
  scope: "global",
  keys: [{ key: "Chinese", type: "concept" }],
};

for (const scenario of [
  {
    name: "policy-denied checkpoint survives restart before dispatch",
    initialAuto: false,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 0,
  },
  {
    name: "eligible checkpoint recovers once after restart before dispatch",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 1,
  },
  {
    name: "temporary admission failure still records an eligible checkpoint for later recovery",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 1,
    admissionFailure: true,
  },
  {
    name: "remember cannot bypass disabled automatic extraction for an older checkpoint",
    initialAuto: true,
    laterAuto: false,
    tagged: true,
    recoveredCalls: 0,
  },
  {
    name: "unmarked manual checkpoint bootstraps without becoming automatic recovery",
    initialAuto: true,
    laterAuto: true,
    tagged: false,
    recoveredCalls: 0,
  },
] as const) {
  test(`atomic memory ${scenario.name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-memory-recovery-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home");
    const sessionId = "recovery-session";
    await mkdir(workDir);
    const paths = resolvePicoPaths(workDir, { picoHome });
    const sessionKey = memorySessionKey(paths.workspace.id, sessionId);
    let session = new Session(sessionId, workDir, { persistence: true, picoHome });
    t.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    const requests: MemoryModelRequest[] = [];
    let requestedSourceRef = "";
    const createRuntime = () =>
      new AtomicMemoryRuntime({
        workDir,
        picoHome,
        sessionId,
        supported: true,
        gate: async () => ({ allowed: true }),
        modelFactory: async () => ({
          model: {
            async call(request) {
              requests.push(structuredClone(request));
              if (request.stage === "canonicalize") {
                return JSON.stringify({
                  results: [
                    { candidateId: "candidate_0", status: "accepted", item: requestedItem },
                  ],
                });
              }
              if (request.prompt.includes("Incidental extraction:")) {
                assert.match(JSON.stringify(request.sourceMessages), /previous project uses Rust/);
                assert.doesNotMatch(
                  JSON.stringify(request.sourceMessages),
                  /concise Chinese answers/,
                );
                return JSON.stringify({
                  status: "complete",
                  coverageStatus: "processed",
                  requestedStatus: "not_applicable",
                  requestedItems: [],
                  incidentalItems: [],
                });
              }
              assert.doesNotMatch(request.prompt, /previous project uses Rust/);
              return JSON.stringify({
                status: "complete",
                coverageStatus: "processed",
                requestedStatus: "resolved",
                requestedItems: [
                  {
                    ...requestedItem,
                    evidence: [{ sourceRef: requestedSourceRef, quote: newFact }],
                  },
                ],
                incidentalItems: [],
              });
            },
          },
        }),
      });
    const updateAutoExtract = async (autoExtract: boolean) => {
      const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
      try {
        const settings = await store.readSettings(paths.workspace.id);
        await store.updateSettings({
          workspaceKey: paths.workspace.id,
          expectedVersion: settings.version,
          autoExtract,
        });
      } finally {
        store.close();
      }
    };
    await updateAutoExtract(scenario.initialAuto);
    const firstRuntime = createRuntime();
    const firstRun = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    const checkpoint = await firstRun.run(async () => {
      await firstRun.commitMessages(session, [
        { role: "user", content: `${oldFact} ${"Old context. ".repeat(80)}` },
        { role: "assistant", content: "Understood. " + "Old context. ".repeat(80) },
        { role: "user", content: "Continue." },
        { role: "assistant", content: "Continuing." },
      ]);
      const recorded = await recordRuntimeCompactionCheckpoint({
        session,
        runtimeRun: firstRun,
        compactor: new FullCompactor({
          provider: {
            async generate() {
              return { role: "assistant", content: "The old project uses Rust." };
            },
          },
          maxAttempts: 1,
        }),
        request: { inputBudgetTokens: 4000, targetRetainedTokens: 1, trigger: "manual" },
        ...(scenario.tagged
          ? {
              memoryDisposition: async () => {
                if ("admissionFailure" in scenario) {
                  throw new Error("temporary memory policy reader failure");
                }
                return firstRuntime.compactionDisposition();
              },
            }
          : {}),
      });
      assert.ok(recorded);
      return recorded;
    });
    const beforeRestart = await session.runtimeEventStore!.readSessionEntries(sessionId);
    const checkpointEvent = beforeRestart.find(
      ({ event }) => event.kind === "context.checkpoint.recorded",
    )!.event;
    assert.ok(checkpointEvent.kind === "context.checkpoint.recorded");
    assert.deepEqual(
      checkpointEvent.data.memoryExtractionBoundary,
      scenario.tagged
        ? {
            runtimeEventId: checkpointEvent.data.throughEventId,
            disposition: scenario.initialAuto ? "eligible" : "policy_denied",
          }
        : undefined,
    );
    const untouched = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      assert.equal(await untouched.readExtractionCursor(sessionKey), undefined);
      assert.deepEqual(
        await untouched.readCompactionPolicyDenials(sessionKey),
        [],
        "no asynchronous dispatch has recorded the denial",
      );
    } finally {
      untouched.close();
    }
    assert.equal(requests.length, 0);

    // Drop all foreground ownership before constructing the recovering runtime.
    // The checkpoint is durable, but checkpoint() was deliberately never dispatched.
    await session.close();
    session = new Session(sessionId, workDir, { persistence: true, picoHome });
    await session.recover();
    await updateAutoExtract(scenario.laterAuto);
    const recovered = createRuntime();
    if (!scenario.tagged) {
      await recovered.checkpoint(checkpoint.checkpointId);
      await recovered.drain();
      assert.equal(requests.length, 0, "manual checkpoint dispatch must remain a no-op");
    }
    const newRun = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await newRun.run(async () => {
      await newRun.commitMessages(session, [{ role: "user", content: newPrompt }]);
      const entries = await session.runtimeEventStore!.readSessionEntries(sessionId);
      const user = entries.find(
        ({ event }) =>
          event.kind === "message.committed" && event.data.message.content === newPrompt,
      )!;
      requestedSourceRef = `event:${user.event.eventId}`;
      await recovered.capture(await newRun.readModelHistory(), []);
      const result = await recovered.remember();
      assert.equal(result.status, "remembered", JSON.stringify({ result, requests }));
      assert.equal(result.requestedItems.length, 1);
      const calls = requests.length;
      assert.equal((await recovered.remember()).status, "remembered");
      assert.equal(
        requests.length,
        calls,
        "replaying the same boundary must use the durable receipt",
      );
    });
    assert.equal(
      requests.filter(
        (request) =>
          request.stage === "proposal" && request.prompt.includes("Incidental extraction:"),
      ).length,
      scenario.recoveredCalls,
    );
    assert.equal(requests.length, scenario.recoveredCalls + 2);
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      const items = await store.listItems({ workspaceKey: paths.workspace.id });
      assert.deepEqual(
        items.map(({ item }) => item.content),
        [newFact],
      );
      assert.ok(await store.readExtractionCursor(sessionKey));
    } finally {
      store.close();
    }
  });
}
