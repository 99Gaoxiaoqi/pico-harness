import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import { SESSION_RUNTIME_STATE_VERSION } from "../../src/engine/session-runtime.js";
import {
  SqliteSessionWorkbarRepository,
  WorkbarConflictError,
  WorkbarForbiddenError,
  WorkbarNotFoundError,
} from "../../src/storage/sqlite/sqlite-session-workbar-repository.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import {
  buildSessionTaskPromptBlock,
  createSessionTaskTools,
} from "../../src/tools/session-tasks.js";
import { BackgroundManager } from "../../src/tools/background-manager.js";
import { TaskListTool } from "../../src/tools/task.js";

test("session workbar authority enforces CAS/idempotency and projects trace", async () => {
  const fixture = await createFixture();
  try {
    const created = fixture.repository.createTask({
      sessionId: "source",
      title: "实现任务权威",
      expectedRevision: 0,
      idempotencyKey: "tool-call-create",
    });
    assert.equal(created.revision, 1);
    assert.deepEqual(
      fixture.repository.createTask({
        sessionId: "source",
        title: "实现任务权威",
        expectedRevision: 0,
        idempotencyKey: "tool-call-create",
      }),
      created,
    );
    assert.throws(
      () =>
        fixture.repository.createTask({
          sessionId: "source",
          title: "不同请求",
          expectedRevision: 1,
          idempotencyKey: "tool-call-create",
        }),
      WorkbarConflictError,
    );
    assert.throws(
      () =>
        fixture.repository.updateTask({
          sessionId: "source",
          taskId: created.task.taskId,
          status: "in_progress",
          expectedRevision: 0,
          idempotencyKey: "stale-update",
        }),
      WorkbarConflictError,
    );
    const updated = fixture.repository.updateTask({
      sessionId: "source",
      taskId: created.task.taskId,
      status: "in_progress",
      expectedRevision: 1,
      idempotencyKey: "tool-call-update",
    });
    assert.equal(updated.revision, 2);
    assert.equal(updated.task.status, "in_progress");

    const modelTaskRevisions: number[] = [];
    const createTool = createSessionTaskTools({
      repository: fixture.repository,
      sessionId: "source",
      onChanged: (revision) => modelTaskRevisions.push(revision),
    }).find((tool) => tool.name() === "task_create");
    assert.ok(createTool);
    const toolResult = await createTool.execute(
      JSON.stringify({ title: "model task", expectedRevision: 2 }),
      { toolCallId: "provider-tool-call" },
    );
    assert.equal(JSON.parse(toolResult).revision, 3);
    assert.equal(
      await createTool.execute(JSON.stringify({ title: "model task", expectedRevision: 2 }), {
        toolCallId: "provider-tool-call",
      }),
      toolResult,
    );
    assert.deepEqual(modelTaskRevisions, [3, 3]);
    assert.ok(
      Buffer.byteLength(buildSessionTaskPromptBlock(fixture.repository, "source", 256)) <= 256,
    );
    const taskList = new TaskListTool(new BackgroundManager(), {
      list: () => fixture.repository.queryTasks({ sessionId: "source", limit: 200 }),
    });
    assert.deepEqual(JSON.parse(await taskList.execute("{}")), []);
    const sessionTaskList = JSON.parse(
      await taskList.execute(JSON.stringify({ scope: "session" })),
    ) as { revision: number; tasks: unknown[] };
    assert.equal(sessionTaskList.revision, 3);
    assert.equal(sessionTaskList.tasks.length, 2);

    await fixture.store.append(internalStateEvent("state-1", "source"));
    await fixture.store.appendTranscriptEvent("source", {
      eventId: "transcript-1",
      sequence: 1,
      createdAt: Date.parse("2026-08-23T00:00:00.000Z"),
      type: "entry.appended",
      entryId: "approval-entry",
      entry: { kind: "approval", title: "Approved", state: "allow" },
    });
    await fixture.store.append(messageEvent("event-1", "source", "hello"));
    await fixture.store.append(messageEvent("event-2", "source", "world"));
    const firstTracePage = fixture.repository.queryTrace({ sessionId: "source", limit: 1 });
    assert.equal(firstTracePage.throughSequence, 4);
    assert.equal(firstTracePage.events.length, 1);
    assert.equal(firstTracePage.nextAfterSequence, 3);
    const fixedTracePage = fixture.repository.queryTrace({
      sessionId: "source",
      throughSequence: firstTracePage.throughSequence,
      afterSequence: firstTracePage.nextAfterSequence,
      limit: 10,
    });
    assert.deepEqual(
      fixedTracePage.events.map((event) => event["eventId"]),
      ["event-2"],
    );
  } finally {
    await fixture.close();
  }
});

test("artifacts are chunked CAS facts and fork/delete preserve lifecycle rules", async () => {
  const fixture = await createFixture();
  try {
    const content = Buffer.from("generated artifact", "utf8");
    const first = fixture.repository.beginArtifact({
      sessionId: "source",
      title: "report.txt",
      mimeType: "text/plain",
      expectedRevision: 0,
      idempotencyKey: "begin-1",
    });
    fixture.repository.appendArtifactChunk({
      sessionId: "source",
      ingestId: first.ingestId,
      offsetBytes: 0,
      content,
    });
    const committed = fixture.repository.commitArtifact({
      sessionId: "source",
      ingestId: first.ingestId,
      expectedRevision: 0,
      idempotencyKey: "commit-1",
      expectedSizeBytes: content.byteLength,
    });
    assert.equal(committed.revision, 1);
    const chunk = fixture.repository.readArtifactChunk({
      sessionId: "source",
      artifactId: committed.artifact.artifactId,
      limitBytes: 4,
    });
    assert.equal(Buffer.from(chunk.contentBase64, "base64").toString("utf8"), "gene");
    assert.equal(chunk.nextOffsetBytes, 4);

    const second = fixture.repository.beginArtifact({
      sessionId: "source",
      title: "copy.txt",
      mimeType: "text/plain",
      expectedRevision: 1,
      idempotencyKey: "begin-2",
    });
    fixture.repository.appendArtifactChunk({
      sessionId: "source",
      ingestId: second.ingestId,
      offsetBytes: 0,
      content,
    });
    fixture.repository.commitArtifact({
      sessionId: "source",
      ingestId: second.ingestId,
      expectedRevision: 1,
      idempotencyKey: "commit-2",
    });
    assert.equal(
      tableCount(fixture.storageRoot, "artifact_blobs"),
      1,
      "same bytes share one CAS blob",
    );

    const task = fixture.repository.createTask({
      sessionId: "source",
      title: "running task",
      expectedRevision: 0,
      idempotencyKey: "task-create",
    });
    fixture.repository.updateTask({
      sessionId: "source",
      taskId: task.task.taskId,
      status: "in_progress",
      expectedRevision: 1,
      idempotencyKey: "task-running",
    });
    fixture.repository.forkSessionData("source", "target");
    const forkTasks = fixture.repository.queryTasks({ sessionId: "target" });
    assert.equal(forkTasks.tasks[0]?.status, "pending");
    assert.notEqual(forkTasks.tasks[0]?.taskId, task.task.taskId);
    const forkArtifacts = fixture.repository.queryArtifacts({ sessionId: "target" });
    assert.equal(forkArtifacts.artifacts.length, 2);
    assert.equal(forkArtifacts.artifacts[0]?.digest, committed.artifact.digest);
    assert.notEqual(forkArtifacts.artifacts[0]?.artifactId, committed.artifact.artifactId);

    fixture.store.setSessionArchived("target", true, () => Date.now());
    assert.throws(
      () =>
        fixture.repository.createTask({
          sessionId: "target",
          title: "forbidden",
          expectedRevision: forkTasks.revision,
          idempotencyKey: "archived-write",
        }),
      WorkbarForbiddenError,
    );

    insertMemoryFact(fixture.storageRoot);
    await fixture.store.deleteSession("source");
    assert.throws(
      () => fixture.repository.queryTasks({ sessionId: "source" }),
      WorkbarNotFoundError,
    );
    assert.equal(
      tableCount(fixture.storageRoot, "memory_facts"),
      1,
      "committed memory fact survives session delete",
    );
    assert.equal(
      tableCount(fixture.storageRoot, "artifact_blobs"),
      1,
      "fork still references CAS blob",
    );
    await fixture.store.deleteSession("target");
    assert.equal(fixture.repository.purgeOrphanArtifactBlobs(), 1);
    assert.equal(tableCount(fixture.storageRoot, "artifact_blobs"), 0);
  } finally {
    await fixture.close();
  }
});

test("artifact append preserves arbitrary bytes and accepts exact chunk replay", async () => {
  const fixture = await createFixture();
  try {
    const content = Buffer.from([0x00, 0xff, 0x80, 0x01, 0x7f]);
    const begun = fixture.repository.beginArtifact({
      sessionId: "source",
      title: "binary.dat",
      mimeType: "application/octet-stream",
      expectedRevision: 0,
      idempotencyKey: "binary-begin",
    });
    const accepted = fixture.repository.appendArtifactChunk({
      sessionId: "source",
      ingestId: begun.ingestId,
      offsetBytes: 0,
      content,
    });
    assert.deepEqual(
      fixture.repository.appendArtifactChunk({
        sessionId: "source",
        ingestId: begun.ingestId,
        offsetBytes: 0,
        content,
      }),
      accepted,
    );
    const committed = fixture.repository.commitArtifact({
      sessionId: "source",
      ingestId: begun.ingestId,
      expectedRevision: 0,
      idempotencyKey: "binary-commit",
    });
    const chunk = fixture.repository.readArtifactChunk({
      sessionId: "source",
      artifactId: committed.artifact.artifactId,
    });
    assert.deepEqual(Buffer.from(chunk.contentBase64, "base64"), content);
  } finally {
    await fixture.close();
  }
});

test("desktop runtime exposes real workbar authorities and publishes revision signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-workbar-desktop-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const canonical = await realpath(workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => ({ ok: true }),
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env: { PICO_HOME: picoHome },
    createSessionId: (() => {
      let index = 0;
      return () => `desktop-workbar-${++index}`;
    })(),
  });
  const notifications: string[] = [];
  const unsubscribe = desktop.subscribe((notification) => notifications.push(notification.topic));
  try {
    const created = asRecord(
      await desktop.handle(createRuntimeRequest("session.create", { workspacePath: workspace })),
    );
    const sessionId = String(asRecord(created["session"])["sessionId"]);
    const command = asRecord(
      await desktop.handle(
        createRuntimeRequest("session.tasks.command", {
          workspacePath: workspace,
          sessionId,
          action: "create",
          title: "wire task",
          expectedRevision: 0,
          idempotencyKey: "wire-task-create",
        }),
      ),
    );
    assert.equal(command["revision"], 1);
    const query = asRecord(
      await desktop.handle(
        createRuntimeRequest("session.tasks.query", { workspacePath: workspace, sessionId }),
      ),
    );
    assert.equal((query["tasks"] as unknown[]).length, 1);
    assert.ok(notifications.includes("session.resourceChanged"));
  } finally {
    unsubscribe();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<{
  readonly storageRoot: string;
  readonly store: SqliteRuntimeEventStore;
  readonly repository: SqliteSessionWorkbarRepository;
  readonly close: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "pico-workbar-authority-"));
  const workspace = join(root, "workspace");
  const storageRoot = join(root, "storage");
  mkdirSync(workspace, { recursive: true });
  const store = new SqliteRuntimeEventStore({ storageRoot });
  await store.initializeSession({ sessionId: "source", workDir: workspace });
  await store.initializeSession({ sessionId: "target", workDir: workspace });
  let id = 0;
  const repository = new SqliteSessionWorkbarRepository({
    storageRoot,
    now: () => 1_700_000_000_000 + id,
    createId: () => `workbar-${++id}`,
  });
  return {
    storageRoot,
    store,
    repository,
    close: async () => {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function messageEvent(eventId: string, sessionId: string, content: string): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "invocation",
    runId: "run",
    turnId: "turn",
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "model",
    kind: "message.committed",
    data: { message: { role: "user", content } },
  };
}

function internalStateEvent(eventId: string, sessionId: string): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId,
    sessionId,
    invocationId: "invocation",
    runId: "run",
    turnId: "turn",
    at: "2026-08-23T00:00:00.000Z",
    partial: false,
    visibility: "internal",
    kind: "session.state.committed",
    data: {
      stateVersion: SESSION_RUNTIME_STATE_VERSION,
      patch: { goal: { stateVersion: 1, sequence: 0, activeGoalId: null, goals: [] } },
    },
  };
}

function tableCount(storageRoot: string, table: string): number {
  return withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  });
}

function insertMemoryFact(storageRoot: string): void {
  withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    database
      .prepare(
        `INSERT INTO memory_facts
         (fact_id, kind, title, content, confidence, source_id, state, pinned, version, created_at, updated_at)
         VALUES ('fact-1', 'project_fact', 'stable', 'keep me', 1, NULL, 'active', 0, 1, ?, ?)`,
      )
      .run("2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
