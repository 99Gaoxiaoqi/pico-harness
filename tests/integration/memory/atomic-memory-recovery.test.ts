import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { RuntimeMemoryExtractionBoundary } from "@pico/core";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import { recordRuntimeCompactionCheckpoint } from "@pico/runtime/runtime-compaction-checkpoint";
import { Session } from "@pico/pico-host/session";
import {
  memorySessionKey,
  type MemoryModelRequest,
} from "@pico/core/atomic-memory-runtime-contracts";
import { resolvePicoPaths } from "@pico/pico-host";
import { AtomicMemoryRuntime } from "@pico/pico-host/atomic-memory-runtime";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

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
    name: "a denied completed admission seals an older eligible checkpoint",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 0,
    completedDisposition: "policy_denied",
  },
  {
    name: "settings revision prevents completed automatic backfill during explicit remember",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 0,
    completedDisposition: "eligible",
  },
  {
    name: "temporary admission failure preserves compaction without reauthorizing old coverage",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 0,
    admissionFailure: true,
  },
  {
    name: "a tagged legacy checkpoint without generations cannot authorize automatic recovery",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 0,
    legacyAdmission: true,
  },
  {
    name: "temporary gate denial recovers the original frozen checkpoint admission",
    initialAuto: true,
    laterAuto: true,
    tagged: true,
    recoveredCalls: 1,
    temporaryGate: true,
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
    const createRuntime = (temporaryGate = false) =>
      new AtomicMemoryRuntime({
        workDir,
        picoHome,
        sessionId,
        supported: true,
        gate: async () =>
          temporaryGate ? { allowed: false, reason: "unavailable" } : { allowed: true },
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
    const updateAutoExtract = async (autoExtract: boolean, forceRevision = false) => {
      const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
      try {
        const settings = await store.readSettings(paths.workspace.id);
        if (settings.autoExtract === autoExtract && !forceRevision) return;
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
    const firstRuntime = createRuntime("temporaryGate" in scenario);
    const firstRun = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    if ("legacyAdmission" in scenario) {
      const recordCheckpoint = firstRun.recordCheckpoint.bind(firstRun);
      t.mock.method(
        firstRun,
        "recordCheckpoint",
        async (input: Parameters<RuntimeRun["recordCheckpoint"]>[0]) =>
          recordCheckpoint({
            ...input,
            memoryExtractionBoundary: {
              runtimeEventId: input.throughEventId,
              disposition: "eligible",
            },
          }),
      );
    }
    let checkpointAdmission: RuntimeMemoryExtractionBoundary | undefined;
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
              return {
                role: "assistant",
                content: [
                  "## Goal\nContinue the project discussion.",
                  "## Progress\nThe previous project context was reviewed.",
                  "## Key Decisions\nThe old project uses Rust.",
                  "## Constraints\nPreserve user constraints.",
                  "## Next Steps\nContinue with the latest user request.",
                  "## Critical Context\nThe old project uses Rust.",
                  "## Evidence\n(none)",
                ].join("\n\n"),
              };
            },
          },
          maxAttempts: 1,
        }),
        request: { inputBudgetTokens: 4000, targetRetainedTokens: 1, trigger: "manual" },
        ...(scenario.tagged
          ? {
              memoryAdmission: async () => {
                if ("admissionFailure" in scenario) {
                  throw new Error("temporary memory policy reader failure");
                }
                checkpointAdmission = await firstRuntime.compactionAdmission();
                return checkpointAdmission;
              },
            }
          : {}),
      });
      assert.ok(recorded);
      if ("completedDisposition" in scenario && scenario.completedDisposition !== undefined) {
        const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
        try {
          firstRun.setMemoryExtractionBoundary({
            disposition: scenario.completedDisposition,
            deletionRevision: await store.readDeletionRevision(),
            settingsVersion: (await store.readSettings(paths.workspace.id)).version,
          });
        } finally {
          store.close();
        }
      }
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
            ...("legacyAdmission" in scenario
              ? { disposition: "eligible" }
              : "admissionFailure" in scenario
                ? { disposition: "policy_denied" }
                : checkpointAdmission),
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
    await updateAutoExtract(
      scenario.laterAuto,
      "completedDisposition" in scenario && scenario.completedDisposition === "eligible",
    );
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

test("explicit remember survives provider failure and recovers from its authorized user event", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-remember-recovery-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  const sessionId = "remember-recovery-session";
  await mkdir(workDir);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const sessionKey = memorySessionKey(paths.workspace.id, sessionId);
  let session = new Session(sessionId, workDir, { persistence: true, picoHome });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const first = new AtomicMemoryRuntime({
    workDir,
    picoHome,
    sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: async () => {
      throw new Error("simulated provider interruption");
    },
  });
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  let authorizationEventId = "";
  await run.run(async () => {
    await run.commitMessages(session, [{ role: "user", content: "Please remember this fact." }]);
    const entries = await session.runtimeEventStore!.readSessionEntries(sessionId);
    const user = entries.find(
      ({ event }) => event.kind === "message.committed" && event.data.message.role === "user",
    )!;
    authorizationEventId = user.event.eventId;
    await first.capture(await run.readModelHistory(), []);
    assert.equal((await first.remember()).status, "unavailable");
  });
  session.close();
  const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
  try {
    const job = db
      .prepare(
        "SELECT source_event_id,trigger,state,model_calls,model_call_budget FROM memory_extraction_jobs WHERE session_id=?",
      )
      .get(sessionKey) as
      | {
          source_event_id: string;
          trigger: string;
          state: string;
          model_calls: number;
          model_call_budget: number;
        }
      | undefined;
    assert.equal(job?.source_event_id, authorizationEventId);
    assert.equal(job?.trigger, "remember");
    assert.equal(job?.state, "pending");
    assert.ok(job.model_call_budget >= 6);
    db.prepare("UPDATE memory_extraction_jobs SET not_before=? WHERE session_id=?").run(
      Date.now(),
      sessionKey,
    );
  } finally {
    db.close();
  }
  session = new Session(sessionId, workDir, { persistence: true, picoHome });
  await session.recover();
  let recoveredCalls = 0;
  const recovered = new AtomicMemoryRuntime({
    workDir,
    picoHome,
    sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: async () => ({
      model: {
        async call(request) {
          assert.equal(request.sourceTools?.length ?? 0, 0);
          recoveredCalls++;
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
  });
  assert.equal(await recovered.recoverPendingJobs(), 1);
  await recovered.drain();
  assert.equal(recoveredCalls, 1);
  const verification = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  try {
    const jobs = await verification.listExtractionJobs({
      workspaceKey: paths.workspace.id,
      sessionId: sessionKey,
    });
    assert.equal(jobs.length, 0);
  } finally {
    verification.close();
  }
});

test("explicit remember retries once after its due time without restart or new input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-remember-retry-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  const sessionId = "remember-retry-session";
  await mkdir(workDir);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const sessionKey = memorySessionKey(paths.workspace.id, sessionId);
  const session = new Session(sessionId, workDir, { persistence: true, picoHome });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  let providerUnavailable = true;
  let providerFailures = 0;
  let recoveryCalls = 0;
  const originalNow = Date.now;
  const originalSetTimeout = globalThis.setTimeout;
  let timeOffset = 0;
  let recoveryWake: (() => void) | undefined;
  let recoveryDelay: number | undefined;
  globalThis.setTimeout = ((
    callback: (...args: never[]) => void,
    delay?: number,
    ...args: never[]
  ) => {
    if (delay !== undefined && delay >= 50_000) {
      recoveryWake = () => callback(...args);
      recoveryDelay = delay;
      return { unref() {} } as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as unknown as typeof setTimeout;
  t.after(() => {
    Date.now = originalNow;
    globalThis.setTimeout = originalSetTimeout;
  });
  const runtime = new AtomicMemoryRuntime({
    workDir,
    picoHome,
    sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: async () => {
      if (providerUnavailable) {
        providerFailures++;
        throw new Error("simulated provider interruption");
      }
      return {
        model: {
          async call() {
            recoveryCalls++;
            return JSON.stringify({
              status: "complete",
              coverageStatus: "processed",
              requestedStatus: "not_applicable",
              requestedItems: [],
              incidentalItems: [],
            });
          },
        },
      };
    },
  });
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  let authorizationEventId = "";
  await run.run(async () => {
    await run.commitMessages(session, [{ role: "user", content: "Please remember this fact." }]);
    const entries = await session.runtimeEventStore!.readSessionEntries(sessionId);
    const user = entries.find(
      ({ event }) => event.kind === "message.committed" && event.data.message.role === "user",
    )!;
    authorizationEventId = user.event.eventId;
    await runtime.capture(await run.readModelHistory(), []);
    assert.equal((await runtime.remember()).status, "unavailable");
  });
  Date.now = () => originalNow() + timeOffset;
  assert.equal(providerFailures, 3, "the initial proposal exhausts its three bounded attempts");
  providerUnavailable = false;
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  try {
    const jobs = await store.listExtractionJobs({
      workspaceKey: paths.workspace.id,
      sessionId: sessionKey,
    });
    assert.equal(jobs[0]?.state, "pending");
    assert.equal(jobs[0]?.trigger, "remember");
    assert.equal(jobs[0]?.sourceEventId, authorizationEventId);
    assert.ok(jobs[0]!.notBefore > Date.now());
    assert.ok(jobs[0]!.notBefore <= Date.now() + 60_000);
  } finally {
    store.close();
  }
  assert.ok(recoveryWake, `the due wake is scheduled at ${recoveryDelay}`);
  timeOffset += recoveryDelay!;
  recoveryWake!();
  for (let attempt = 0; attempt < 10 && recoveryCalls === 0; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.drain();
  }
  assert.equal(recoveryCalls, 1, "the same runtime retries the durable remember job once");
  timeOffset += 60_000;
  recoveryWake?.();
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await runtime.drain();
  }
  assert.equal(recoveryCalls, 1, "a settled remember job does not run again");
});
