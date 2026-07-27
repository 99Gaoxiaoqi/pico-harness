import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import {
  WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
} from "../../src/storage/workspace-storage-layout.js";

test("RuntimeEventStore persists hashed Session JSONL and rebuilds its manifest projection", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-files-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const store = new RuntimeEventStore({ storageRoot: root });
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
  assert.equal(batch["activeBranchId"], "branch-2");
  assert.equal((batch["entries"] as unknown[]).length, 2);
  assert.equal((await stat(sessionDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, ".storage"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, "runtime", "lock"))).mode & 0o777, 0o700);

  delete batch["activeBranchId"];
  await writeFile(logPath, `${lines[0]}\n${JSON.stringify(batch)}\n`, { mode: 0o600 });
  await unlink(manifestPath);
  assert.equal((await store.readSessionManifest(manifest.sessionId))?.activeBranchId, "branch-2");
  assert.equal(
    JSON.parse(await readFile(manifestPath, "utf8")).manifest.activeBranchId,
    "branch-2",
  );
});

test("RuntimeEventStore rejects a forged manifest branch and rebuilds it from the ledger tail", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-forged-manifest-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const store = new RuntimeEventStore({ storageRoot: root });
  const manifest = await store.initializeSession({
    sessionId: "manifest-session",
    workDir: workspace,
  });
  await store.append(runtimeEvent(manifest.sessionId, "run-1", "event-1", workspace));
  const digest = createHash("sha256").update(manifest.sessionId).digest("hex");
  const manifestPath = join(store.storageRoot, "sessions", digest, "manifest.json");
  const projection = JSON.parse(await readFile(manifestPath, "utf8")) as {
    manifest: { activeBranchId: string };
  };
  projection.manifest.activeBranchId = "forged";
  await writeFile(manifestPath, `${JSON.stringify(projection)}\n`, { mode: 0o600 });

  assert.equal((await store.listSessionManifests())[0]?.activeBranchId, "main");
  assert.equal(
    (JSON.parse(await readFile(manifestPath, "utf8")) as typeof projection).manifest.activeBranchId,
    "main",
  );
});

test("RuntimeEventStore preserves idempotency and rejects a cross-Session batch before any append", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-atomic-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: root });
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

test("RuntimeEventStore replays a fully persisted CAS batch but fences mixed replay and new events", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-cas-replay-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: root });
  const sessionId = "cas-replay-session";
  await store.initializeSession({ sessionId, workDir: workspace });
  const persisted = [
    runtimeEvent(sessionId, "run-1", "cas-event-1", workspace),
    runtimeEvent(sessionId, "run-1", "cas-event-2", workspace),
  ];

  assert.deepEqual(
    (
      await store.appendBatch(persisted, {
        expectedSessionHighWater: { [sessionId]: 0 },
      })
    ).map(({ inserted, cursor }) => [inserted, cursor.seq]),
    [
      [true, 1],
      [true, 2],
    ],
  );
  const ledgerBeforeReplay = await readFile(sessionLogPath(store, sessionId));
  assert.deepEqual(
    (
      await store.appendBatch(structuredClone(persisted), {
        expectedSessionHighWater: { [sessionId]: 0 },
      })
    ).map(({ inserted, cursor }) => [inserted, cursor.seq]),
    [
      [false, 1],
      [false, 2],
    ],
  );
  assert.deepEqual(await readFile(sessionLogPath(store, sessionId)), ledgerBeforeReplay);

  await assert.rejects(
    store.appendBatch(
      [
        structuredClone(persisted[0]!),
        runtimeEvent(sessionId, "run-2", "cas-event-new", workspace),
      ],
      { expectedSessionHighWater: { [sessionId]: 0 } },
    ),
    /high-water changed from 0 to 2/u,
  );
  assert.deepEqual(await readFile(sessionLogPath(store, sessionId)), ledgerBeforeReplay);
  assert.deepEqual(
    (await store.readSessionEntries(sessionId)).map(({ event }) => event.eventId),
    ["cas-event-1", "cas-event-2"],
  );
});

test("RuntimeEventStore recovers a published cross-file commit before reading", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-recover-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: root });
  await store.initializeSession({ sessionId: "recover-session", workDir: workspace });
  const event = runtimeEvent("recover-session", "recover-run", "recover-event", workspace);
  const transactionId = "recovery-transaction";
  const batch = {
    type: "event-batch",
    schemaVersion: 1,
    txId: transactionId,
    committedAt: event.at,
    activeBranchId: "main",
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
          ...WORKSPACE_RUNTIME_TRANSACTION_OPTIONS,
          transactionId,
          onStage(stage) {
            if (stage === "commit-published") throw new Error("injected crash");
          },
        },
      ),
    /injected crash/u,
  );
  assert.equal((await store.readSession(event.sessionId))[0]?.eventId, event.eventId);
  await assert.rejects(stat(join(store.storageRoot, WORKSPACE_STORAGE_COMMIT_FILE)), {
    code: "ENOENT",
  });
});

test("RuntimeEventStore serializes independent process writers without losing sequences", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-processes-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new RuntimeEventStore({ storageRoot: root });
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

test("RuntimeEventStore repairs an incomplete tail and rejects complete malformed records", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-corrupt-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const incompleteStore = new RuntimeEventStore({ storageRoot: join(root, "incomplete") });
  await incompleteStore.initializeSession({ sessionId: "incomplete", workDir: workspace });
  const incompletePath = sessionLogPath(incompleteStore, "incomplete");
  await appendFile(incompletePath, '{"type":"event-batch"');
  assert.deepEqual(await incompleteStore.readSession("incomplete"), []);
  assert.equal((await readFile(incompletePath, "utf8")).trimEnd().split("\n").length, 1);

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

test("RuntimeEventStore readOnly mode neither repairs nor accepts mutations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-read-only-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "read-only-session";
  const writable = new RuntimeEventStore({ storageRoot: root });
  await writable.initializeSession({ sessionId, workDir: workspace });
  const existing = runtimeEvent(sessionId, "run-1", "event-1", workspace);
  await writable.append(existing);
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const ledgerPath = join(root, "sessions", digest, "session.jsonl");
  const manifestPath = join(root, "sessions", digest, "manifest.json");
  const staleManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    manifest: { activeBranchId: string };
  };
  staleManifest.manifest.activeBranchId = "stale-read-only-projection";
  await writeFile(manifestPath, `${JSON.stringify(staleManifest)}\n`, { mode: 0o600 });
  const beforeLedger = await readFile(ledgerPath);
  const beforeManifest = await readFile(manifestPath);

  assert.throws(
    () => new RuntimeEventStore({ storageRoot: root }, { readOnly: true, repairManifests: true }),
    /readOnly mode cannot enable repairs/u,
  );
  assert.throws(
    () =>
      new RuntimeEventStore({ storageRoot: root }, { readOnly: true, repairIncompleteTails: true }),
    /readOnly mode cannot enable repairs/u,
  );
  const readOnly = new RuntimeEventStore({ storageRoot: root }, { readOnly: true });
  assert.equal((await readOnly.readSessionManifest(sessionId))?.activeBranchId, "main");
  assert.deepEqual(await readFile(manifestPath), beforeManifest);

  for (const mutation of [
    () => readOnly.initializeSession({ sessionId: "new-session", workDir: workspace }),
    () => readOnly.append(runtimeEvent(sessionId, "run-2", "event-2", workspace)),
    () => readOnly.appendBatch([runtimeEvent(sessionId, "run-2", "event-3", workspace)]),
    () => readOnly.appendSessionState(sessionId, {}),
    () => readOnly.appendTranscriptEvent(sessionId, {} as never),
    () => readOnly.deleteSession(sessionId),
  ]) {
    await assert.rejects(mutation(), /RuntimeEventStore is read-only/u);
  }
  assert.deepEqual(await readFile(ledgerPath), beforeLedger);
  assert.deepEqual(await readFile(manifestPath), beforeManifest);

  await appendFile(ledgerPath, '{"type":"event-batch"');
  const incompleteLedger = await readFile(ledgerPath);
  await assert.rejects(readOnly.readSession(sessionId), /incomplete final record/u);
  assert.deepEqual(await readFile(ledgerPath), incompleteLedger);
  assert.deepEqual(await readFile(manifestPath), beforeManifest);
});

test("RuntimeEventStore rejects a post-construction Session root symlink without touching its target", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-event-session-root-symlink-"));
  const storageRoot = join(root, "state");
  const workspace = join(root, "workspace");
  const externalSessionsRoot = join(root, "external-sessions");
  const sessionId = "session-root-symlink";
  await mkdir(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));

  const store = new RuntimeEventStore({ storageRoot });
  await store.initializeSession({ sessionId, workDir: workspace });
  await store.append(runtimeEvent(sessionId, "run-1", "event-1", workspace));
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const sessionsRoot = join(storageRoot, "sessions");
  const externalSessionRoot = join(externalSessionsRoot, digest);
  const externalLogPath = join(externalSessionRoot, "session.jsonl");
  const externalManifestPath = join(externalSessionRoot, "manifest.json");
  const logBytes = await readFile(join(sessionsRoot, digest, "session.jsonl"));
  const manifestBytes = await readFile(join(sessionsRoot, digest, "manifest.json"));

  await rename(sessionsRoot, externalSessionsRoot);
  await symlink(externalSessionsRoot, sessionsRoot, "dir");
  const readError = await captureError(() => store.readSession(sessionId));
  await writeFile(externalManifestPath, "invalid external manifest\n", { mode: 0o600 });
  const invalidManifestBytes = await readFile(externalManifestPath);
  const repairError = await captureError(() => store.readSessionManifest(sessionId));
  const writeError = await captureError(() =>
    store.append(runtimeEvent(sessionId, "run-2", "event-2", workspace)),
  );
  const deleteError = await captureError(() => store.deleteSession(sessionId));

  for (const error of [readError, repairError, writeError, deleteError]) {
    assert.equal(error instanceof RuntimeEventStoreIntegrityError, true);
    assert.match((error as Error).message, /Session storage must be a real directory/u);
  }
  assert.equal((await stat(externalSessionRoot)).isDirectory(), true);
  assert.deepEqual(await readFile(externalLogPath), logBytes);
  assert.deepEqual(await readFile(externalManifestPath), invalidManifestBytes);
  assert.notDeepEqual(invalidManifestBytes, manifestBytes);
});

function sessionLogPath(store: RuntimeEventStore, sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex");
  return join(store.storageRoot, "sessions", digest, "session.jsonl");
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return undefined;
  } catch (error) {
    return error;
  }
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
