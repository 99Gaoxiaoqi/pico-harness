import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { commitFileTransactionSync } from "../../src/storage/local-file-storage.js";
import {
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
} from "../../src/storage/runtime-event.js";
import {
  RuntimeEventStore,
  RuntimeEventStoreIntegrityError,
} from "../../src/storage/runtime-event-store.js";

test("RuntimeEventStore persists hashed Session JSONL and rebuilds its manifest projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-files-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const store = new RuntimeEventStore({ storageRoot: join(root, "runtime") });
  const manifest = await store.initializeSession({
    sessionId: "session/with:path",
    workDir: workspace,
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
  const started = runtimeEvent("session/with:path", "run-1", "event-1", workspace);
  const rewind = runtimeEvent(
    "session/with:path",
    "run-1",
    "event-2",
    workspace,
    "history.rewound",
  );

  const results = await store.appendBatch([started, rewind]);
  assert.deepEqual(
    results.map(({ inserted, cursor }) => ({
      inserted,
      sequence: cursor.seq,
      epoch: cursor.epoch,
    })),
    [
      { inserted: true, sequence: 1, epoch: 0 },
      { inserted: true, sequence: 2, epoch: 1 },
    ],
  );

  const digest = createHash("sha256").update(manifest.sessionId).digest("hex");
  const sessionDirectory = join(store.storageRoot, "sessions", digest);
  const logPath = join(sessionDirectory, "session.jsonl");
  const manifestPath = join(sessionDirectory, "manifest.json");
  const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), {
    type: "session",
    schemaVersion: 1,
    sessionId: manifest.sessionId,
    workDir: manifest.workDir,
    historySource: "runtime-event-v1",
    createdAt: manifest.createdAt,
  });
  const batch = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(batch["type"], "event-batch");
  assert.equal((batch["entries"] as unknown[]).length, 2);
  assert.equal((await stat(sessionDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);

  await unlink(manifestPath);
  assert.equal((await store.readSessionManifest(manifest.sessionId))?.activeBranchId, "branch-2");
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).activeBranchId, "branch-2");
});

test("RuntimeEventStore preserves idempotency and rejects a cross-Session batch before any append", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-atomic-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "runtime") });
  await store.initializeSession({ sessionId: "session-a", workDir: workspace });
  await store.initializeSession({ sessionId: "session-b", workDir: workspace });

  const existing = runtimeEvent("session-b", "run-b", "shared-id", workspace);
  assert.equal((await store.append(existing)).inserted, true);
  assert.equal((await store.append(structuredClone(existing))).inserted, false);

  const newForA = runtimeEvent("session-a", "run-a", "new-a", workspace);
  const conflicting = {
    ...existing,
    turnId: "turn:conflicting",
  } satisfies RuntimeEvent;
  await assert.rejects(
    store.appendBatch([newForA, conflicting]),
    (error: unknown) =>
      error instanceof RuntimeEventStoreIntegrityError &&
      /already bound to another payload/u.test(error.message),
  );
  assert.deepEqual(await store.readSession("session-a"), []);
  assert.deepEqual(
    (await store.readSessionEntries("session-b")).map(({ sequence, event }) => [
      sequence,
      event.eventId,
    ]),
    [[1, "shared-id"]],
  );
});

test("RuntimeEventStore recovers a published cross-file commit before reading", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-recover-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "runtime") });
  await store.initializeSession({ sessionId: "recover-session", workDir: workspace });
  const event = runtimeEvent("recover-session", "recover-run", "recover-event", workspace);
  const transactionId = "recovery-transaction";
  const batch = {
    type: "event-batch",
    schemaVersion: 1,
    txId: transactionId,
    committedAt: event.at,
    entries: [{ sequence: 1, committedAt: event.at, event }],
  };

  assert.throws(
    () =>
      commitFileTransactionSync(
        store.storageRoot,
        {
          appends: [
            {
              relativePath: join(
                "sessions",
                createHash("sha256").update(event.sessionId).digest("hex"),
                "session.jsonl",
              ),
              content: `${JSON.stringify(batch)}\n`,
            },
          ],
        },
        {
          transactionId,
          onStage(stage) {
            if (stage === "commit-published") throw new Error("injected crash");
          },
        },
      ),
    /injected crash/u,
  );
  assert.equal((await store.readSession(event.sessionId))[0]?.eventId, event.eventId);
  await assert.rejects(stat(join(store.storageRoot, "commit.json")), { code: "ENOENT" });
});

test("RuntimeEventStore serializes independent process writers without losing sequences", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-processes-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: join(root, "runtime") });
  await store.initializeSession({ sessionId: "shared-session", workDir: workspace });

  const childScript = `
    import { RuntimeEventStore } from "./src/storage/runtime-event-store.ts";
    import { RUNTIME_EVENT_SCHEMA_VERSION } from "./src/storage/runtime-event.ts";
    const store = new RuntimeEventStore({ storageRoot: process.env.TEST_STORAGE_ROOT });
    const prefix = process.env.TEST_EVENT_PREFIX;
    await store.appendBatch(Array.from({ length: 8 }, (_, index) => ({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: prefix + ":" + index,
      sessionId: "shared-session",
      invocationId: "invocation:" + prefix,
      runId: "run:" + prefix,
      turnId: "turn:" + prefix,
      at: "2026-07-25T00:00:00.000Z",
      partial: false,
      visibility: "internal",
      kind: "run.started",
      data: { workDir: process.env.TEST_WORKSPACE },
    })));
  `;
  const runChild = async (prefix: string) => {
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_STORAGE_ROOT: store.storageRoot,
          TEST_WORKSPACE: workspace,
          TEST_EVENT_PREFIX: prefix,
        },
      },
    );
  };
  await Promise.all([runChild("left"), runChild("right")]);

  const entries = await store.readSessionEntries("shared-session");
  assert.deepEqual(
    entries.map(({ sequence }) => sequence),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.deepEqual([...new Set(entries.map(({ event }) => event.eventId.split(":")[0]))].sort(), [
    "left",
    "right",
  ]);
});

test("RuntimeEventStore fails closed for incomplete tails and complete malformed records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-corrupt-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const incompleteStore = new RuntimeEventStore({ storageRoot: join(root, "incomplete") });
  await incompleteStore.initializeSession({ sessionId: "incomplete", workDir: workspace });
  await appendFile(sessionLogPath(incompleteStore, "incomplete"), '{"type":"event-batch"');
  await assert.rejects(
    incompleteStore.readSession("incomplete"),
    (error: unknown) =>
      error instanceof RuntimeEventStoreIntegrityError &&
      /incomplete final record/u.test(error.message),
  );

  const malformedStore = new RuntimeEventStore({ storageRoot: join(root, "malformed") });
  await malformedStore.initializeSession({ sessionId: "malformed", workDir: workspace });
  await appendFile(sessionLogPath(malformedStore, "malformed"), "{not-json}\n");
  await assert.rejects(
    malformedStore.readSession("malformed"),
    (error: unknown) =>
      error instanceof RuntimeEventStoreIntegrityError &&
      /record 2 is invalid/u.test(error.message),
  );
});

function sessionLogPath(store: RuntimeEventStore, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(store.storageRoot, "sessions", digest, "session.jsonl");
}

function runtimeEvent(
  sessionId: string,
  runId: string,
  eventId: string,
  workDir: string,
  kind: "run.started" | "history.rewound" = "run.started",
): RuntimeEvent {
  const base = {
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    eventId,
    sessionId,
    invocationId: `invocation:${runId}`,
    runId,
    turnId: `turn:${runId}`,
    at: "2026-07-25T00:00:00.000Z",
    partial: false,
    visibility: "internal" as const,
  };
  return kind === "run.started"
    ? { ...base, kind, data: { workDir } }
    : { ...base, kind, data: { branchId: "branch-2" } };
}
