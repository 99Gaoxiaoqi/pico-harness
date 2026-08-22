import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Session } from "../../src/engine/session.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import {
  RuntimeEventStoreIntegrityError,
  RuntimeEventStoreOwnerFenceError,
  RuntimeEventStoreRunSealedError,
  type StartRuntimeContinuationInput,
} from "../../src/storage/runtime-event-store-contracts.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import type { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

interface Scene {
  readonly session: Session;
  readonly store: SqliteRuntimeEventStore;
}

async function createScene(context: test.TestContext, name: string): Promise<Scene> {
  const root = await mkdtemp(join(tmpdir(), `pico-continuation-${name}-`));
  const session = new Session(name, join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort: createEngineRuntimePort(),
  });
  context.after(async () => {
    await session.close();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  assert.ok(session.runtimeEventStore);
  return { session, store: session.runtimeEventStore };
}

async function interrupted(scene: Scene, content = "source-prefix"): Promise<RuntimeRun> {
  const run = await RuntimeRun.start({ capability: scene.session.runtimeEventCapability! });
  await run.recordTurnStarted(1);
  await run.commitMessages(scene.session, [{ role: "user", content }]);
  await run.finish("interrupted", "test interruption");
  return run;
}

function startInput(
  scene: Scene,
  sourceRunId: string,
  targetRunId: string,
): StartRuntimeContinuationInput {
  return {
    sessionId: scene.session.id,
    sourceRunId,
    targetRunId,
    invocationId: `invocation:${targetRunId}`,
    startEventId: `run-started:${targetRunId}`,
    workDir: scene.session.workDir,
    startedAt: "2026-08-22T08:00:00.000Z",
    now: () => new Date("2026-08-22T08:00:00.000Z"),
  };
}

async function startContinuation(scene: Scene, input: StartRuntimeContinuationInput) {
  return scene.store.startContinuation({
    ...input,
    ownerFence: await scene.session.assertRuntimeEventWriteAllowed(),
  });
}

function sortedKeysJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedKeysJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedKeysJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function prefixDigest(
  entries: readonly { sequence: number; event: RuntimeEvent }[],
  highWater: number,
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (entry.sequence > highWater) continue;
    hash.update(
      `${JSON.stringify({
        seq: entry.sequence,
        eventId: entry.event.eventId,
        payload: sortedKeysJson(entry.event),
      })}\n`,
    );
  }
  return hash.digest("hex");
}

test("continuation claim 与 target run.started 同事务落库，精确重放幂等", async (context) => {
  const scene = await createScene(context, "atomic-happy");
  const source = await interrupted(scene);
  const before = await scene.store.readSessionEntries(scene.session.id);
  const input = startInput(scene, source.runId, "target-atomic");

  const first = await startContinuation(scene, input);
  assert.equal(first.status, "started");
  assert.equal(first.append.inserted, true);
  assert.equal(first.claim.sourceHighWater, before.at(-1)!.sequence);
  assert.equal(first.claim.sourcePrefixDigest, prefixDigest(before, first.claim.sourceHighWater));
  assert.deepEqual(first.startEvent.data.continuationOf, {
    runId: source.runId,
    highWater: first.claim.sourceHighWater,
    prefixDigest: first.claim.sourcePrefixDigest,
  });

  const replay = await startContinuation(scene, input);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.append.inserted, false);
  assert.deepEqual(replay.claim, first.claim);
  assert.equal((await scene.store.readSessionEntries(scene.session.id)).length, before.length + 1);

  const attached = await RuntimeRun.startContinuation({
    capability: scene.session.runtimeEventCapability!,
    sourceRunId: source.runId,
    targetRunId: input.targetRunId,
    invocationId: input.invocationId,
    runStartedEventId: input.startEventId,
    startedAt: input.startedAt,
  });
  assert.ok(attached, "RuntimeRun must attach the atomically prestarted target");
  await attached.recordTurnStarted(1);
  await attached.commitMessages(scene.session, [{ role: "user", content: "continued" }]);
  await attached.finish("completed");
  assert.equal(
    (await scene.store.readRun(scene.session.id, input.targetRunId)).filter(
      (event) => event.kind === "run.started",
    ).length,
    1,
  );
});

test("continuation 换 target/source/起点载荷均 fail-closed", async (context) => {
  const scene = await createScene(context, "atomic-conflicts");
  const sourceA = await interrupted(scene, "source-a");
  const sourceB = await interrupted(scene, "source-b");
  const input = startInput(scene, sourceA.runId, "target-a");
  const started = await startContinuation(scene, input);
  assert.equal(started.status, "started");
  const baseline = await scene.store.readSessionEntries(scene.session.id);

  await assert.rejects(
    startContinuation(scene, { ...input, targetRunId: "target-b" }),
    RuntimeEventStoreIntegrityError,
  );
  await assert.rejects(
    startContinuation(scene, { ...input, invocationId: "invocation:forged" }),
    RuntimeEventStoreIntegrityError,
  );
  assert.deepEqual(
    await startContinuation(scene, startInput(scene, sourceB.runId, input.targetRunId)),
    { status: "rejected", reason: "target_conflict" },
  );
  assert.deepEqual(await scene.store.readSessionEntries(scene.session.id), baseline);
});

test("continuation failpoint 不留孤立 claim/start，清洁重试可成功", async (context) => {
  const scene = await createScene(context, "atomic-rollback");
  const source = await interrupted(scene);
  const input = startInput(scene, source.runId, "target-after-crash");
  const baseline = await scene.store.readSessionEntries(scene.session.id);

  await assert.rejects(
    startContinuation(scene, {
      ...input,
      afterClaimBeforeStart: () => {
        throw new Error("simulated crash");
      },
    }),
    /simulated crash/u,
  );
  assert.equal(
    await scene.store.findContinuationClaimBySourceRun(scene.session.id, source.runId),
    undefined,
  );
  assert.deepEqual(await scene.store.readSessionEntries(scene.session.id), baseline);

  const retry = await startContinuation(scene, input);
  assert.equal(retry.status, "started");
});

test("continuation 原子事务拒绝 owner takeover 前的陈旧 fence", async (context) => {
  const scene = await createScene(context, "atomic-stale-fence");
  const source = await interrupted(scene);
  const staleFence = await scene.session.assertRuntimeEventWriteAllowed();
  await scene.store.advanceOwnerFence(scene.session.id, staleFence.epoch);

  await assert.rejects(
    scene.store.startContinuation({
      ...startInput(scene, source.runId, "target-stale-owner"),
      ownerFence: staleFence,
    }),
    RuntimeEventStoreOwnerFenceError,
  );
  assert.equal(
    await scene.store.findContinuationClaimBySourceRun(scene.session.id, source.runId),
    undefined,
  );
  assert.deepEqual(await scene.store.readRun(scene.session.id, "target-stale-owner"), []);
});

test("旧两事务路径与伪造 continuationOf 均被拒绝", async (context) => {
  const scene = await createScene(context, "legacy-fail-closed");
  const source = await interrupted(scene);
  await assert.rejects(
    scene.store.claimContinuation(scene.session.id, source.runId, "legacy-target"),
    /Standalone continuation claims are disabled/u,
  );
  await assert.rejects(
    RuntimeRun.start({
      capability: scene.session.runtimeEventCapability!,
      continuationOf: { runId: source.runId, highWater: 1, prefixDigest: "0".repeat(64) },
    } as Parameters<typeof RuntimeRun.start>[0]),
    /startContinuation/u,
  );
  await assert.rejects(
    scene.store.append(
      {
        schemaVersion: 2,
        eventId: "forged-continuation-start",
        sessionId: scene.session.id,
        invocationId: "invocation:forged",
        runId: "forged-target",
        turnId: "turn:forged-target:input",
        at: new Date().toISOString(),
        partial: false,
        visibility: "internal",
        kind: "run.started",
        data: {
          workDir: scene.session.workDir,
          continuationOf: { runId: source.runId, highWater: 1, prefixDigest: "0".repeat(64) },
        },
      } as RuntimeEvent,
      { ownerFence: await scene.session.assertRuntimeEventWriteAllowed() },
    ),
    /must be produced by startContinuation/u,
  );
});

test("run.terminal 是严格 immutable tail，仅精确重放可过", async (context) => {
  const scene = await createScene(context, "strict-terminal");
  const source = await interrupted(scene);
  const events = await scene.store.readRun(scene.session.id, source.runId);
  const terminal = events.at(-1)!;
  assert.equal(terminal.kind, "run.terminal");
  await assert.rejects(
    scene.store.append(
      {
        ...terminal,
        eventId: "after-terminal",
        kind: "message.committed",
        visibility: "model",
        data: { message: { role: "user", content: "late write" } },
      } as RuntimeEvent,
      { ownerFence: await scene.session.assertRuntimeEventWriteAllowed() },
    ),
    RuntimeEventStoreRunSealedError,
  );
  assert.equal(
    (
      await scene.store.append(terminal, {
        ownerFence: await scene.session.assertRuntimeEventWriteAllowed(),
      })
    ).inserted,
    false,
  );
});
