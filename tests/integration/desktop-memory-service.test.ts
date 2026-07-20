import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopMemoryService, mapMemoryError } from "../../src/daemon/desktop-memory-service.js";
import { RUNTIME_ERROR_CODES, RuntimeProtocolError } from "../../src/daemon/protocol.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

test("Desktop memory service preserves CAS/idempotency and never exposes storage paths", async (context) => {
  const fixture = await createFixture("writes");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const source = repository.createSource({
    sourceId: "source-1",
    sessionId: "session-1",
    branchId: "main",
    digest: "sha256:safe-source",
  });
  const fact = repository.createFact({
    factId: "fact-1",
    kind: "preference",
    title: "Language",
    content: "Reply in Chinese",
    sourceId: source.sourceId,
  });
  repository.close();

  const notifications: unknown[] = [];
  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: (_workspacePath, topic, payload) => notifications.push({ topic, payload }),
  });
  context.after(() => service.close());

  const listed = service.list(fixture.workspace, {
    workspacePath: fixture.workspace,
    states: ["active"],
  });
  assert.equal(listed.facts.length, 1);
  assert.equal("databasePath" in listed.facts[0]!, false);
  assert.deepEqual(listed.facts[0]!.source, {
    sourceId: "source-1",
    sessionId: "session-1",
    branchId: "main",
    availability: "available",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  });
  assert.equal("digest" in listed.facts[0]!.source!, false);
  assert.equal("eventIds" in listed.facts[0]!.source!, false);

  const params = {
    workspacePath: fixture.workspace,
    factId: fact.factId,
    expectedVersion: fact.version,
    idempotencyKey: "update-1",
    pinned: true,
  } as const;
  const updated = service.update(fixture.workspace, params);
  const replay = service.update(fixture.workspace, params);
  assert.deepEqual(replay, updated);
  assert.equal(updated.fact.version, 2);
  assert.equal(notifications.length, 1, "idempotent replay must not duplicate durable events");
  assert.equal(
    (notifications[0] as { payload: Record<string, unknown> }).payload["content"],
    undefined,
  );

  assertRuntimeError(
    () =>
      service.update(fixture.workspace, {
        ...params,
        idempotencyKey: "update-stale",
        pinned: false,
      }),
    RUNTIME_ERROR_CODES.CONFLICT,
  );
  assertRuntimeError(
    () => service.get(fixture.workspace, "missing-fact"),
    RUNTIME_ERROR_CODES.NOT_FOUND,
  );
  const internal = mapMemoryError(new Error("failed at /private/secret/memory.sqlite"));
  assert.equal(internal.code, RUNTIME_ERROR_CODES.INTERNAL_ERROR);
  assert.equal(internal.message.includes("/private/secret"), false);
  const pendingDelete = new Error("pending secure delete at /private/secret/memory.sqlite");
  pendingDelete.name = "MemorySecureDeletePendingError";
  const mappedPendingDelete = mapMemoryError(pendingDelete);
  assert.equal(mappedPendingDelete.code, RUNTIME_ERROR_CODES.CONFLICT);
  assert.equal(mappedPendingDelete.message.includes("/private/secret"), false);
});

test("session deletion and rewind invalidate sources and pending proposals but retain facts", async (context) => {
  const fixture = await createFixture("lifecycle");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const deletedSource = repository.createSource({
    sourceId: "source-delete",
    sessionId: "session-delete",
    digest: "sha256:delete",
  });
  repository.createFact({
    factId: "approved-fact",
    kind: "project_fact",
    title: "Build",
    content: "Use npm run build",
    sourceId: deletedSource.sourceId,
  });
  repository.createProposal({
    proposalId: "pending-delete",
    kind: "project_fact",
    title: "Pending",
    content: "Pending body",
    reason: "Pending reason",
    sourceId: deletedSource.sourceId,
  });
  const rewindSource = repository.createSource({
    sourceId: "source-rewind",
    sessionId: "session-rewind",
    digest: "sha256:rewind",
    startSequence: 11,
    endSequence: 15,
  });
  repository.createProposal({
    proposalId: "pending-rewind",
    kind: "correction",
    title: "Pending rewind",
    content: "Pending rewind body",
    reason: "Pending rewind reason",
    sourceId: rewindSource.sourceId,
  });
  const beforeRewindSource = repository.createSource({
    sourceId: "source-before-rewind",
    sessionId: "session-rewind",
    digest: "sha256:before-rewind",
    startSequence: 1,
    endSequence: 10,
  });
  repository.createProposal({
    proposalId: "pending-before-rewind",
    kind: "reference",
    title: "Before rewind",
    content: "Must remain pending",
    reason: "Source is before the checkpoint",
    sourceId: beforeRewindSource.sourceId,
  });
  repository.close();

  const events: Array<{ readonly topic: string; readonly payload: Record<string, unknown> }> = [];
  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: (_workspacePath, topic, payload) => events.push({ topic, payload }),
  });
  service.invalidateSessionSources(fixture.workspace, "session-delete", {
    availability: "unavailable",
    code: "session_deleted",
  });
  service.invalidateSessionSources(fixture.workspace, "session-rewind", {
    availability: "rewound",
    code: "rewind_checkpoint-1",
    afterSequence: 10,
  });
  assert.equal(
    service.get(fixture.workspace, "approved-fact").fact.source?.availability,
    "unavailable",
  );
  service.close();

  const verify = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  context.after(() => verify.close());
  assert.equal(verify.getSource("source-delete")?.availability, "unavailable");
  assert.equal(verify.getSource("source-rewind")?.availability, "rewound");
  assert.equal(verify.getSource("source-before-rewind")?.availability, "available");
  assert.equal(verify.getProposal("pending-delete")?.status, "deleted");
  assert.equal(verify.getProposal("pending-rewind")?.status, "deleted");
  assert.equal(verify.getProposal("pending-before-rewind")?.status, "pending");
  assert.equal(verify.getFact("approved-fact")?.state, "active");
  assert.equal(verify.getFact("approved-fact")?.content, "Use npm run build");
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => !("content" in event.payload) && !("reason" in event.payload)));
});

test("context preview matches the first recall policy and reports an 800-token budget", async (context) => {
  const fixture = await createFixture("preview");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  repository.createFact({
    factId: "reference",
    kind: "reference",
    title: "Reference",
    content: "Reference body",
    lastUsedAt: "2026-07-19T00:00:00.000Z",
  });
  repository.createFact({
    factId: "project",
    kind: "project_fact",
    title: "Project",
    content: "Project body",
  });
  repository.createFact({
    factId: "correction",
    kind: "correction",
    title: "Correction",
    content: "Correction body",
  });
  repository.createFact({
    factId: "pinned",
    kind: "preference",
    title: "Pinned",
    content: "Pinned body",
    pinned: true,
  });
  repository.createFact({
    factId: "expired",
    kind: "correction",
    title: "Expired",
    content: "Expired body",
    expiresAt: "2026-07-19T00:00:00.000Z",
  });
  repository.createFact({
    factId: "over-budget",
    kind: "reference",
    title: "Large",
    content: "x".repeat(900),
  });
  repository.close();

  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    now: () => Date.parse("2026-07-20T00:00:00.000Z"),
    publish: () => undefined,
  });
  context.after(() => service.close());
  const preview = service.previewContext(fixture.workspace, {
    workspacePath: fixture.workspace,
    maxFacts: 99,
    maxTokens: 9_999,
  });
  assert.deepEqual(
    preview.facts.map((fact) => fact.factId),
    ["pinned", "correction", "project", "reference"],
  );
  assert.equal(preview.budget.maxFacts, 6);
  assert.equal(preview.budget.maxTokens, 800);
  assert.equal(preview.budget.usedFacts, 4);
  assert.equal(preview.budget.truncated, true);
});

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly picoHome: string;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-desktop-${name}-`));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(picoHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  return { root, picoHome, workspace };
}

function assertRuntimeError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof RuntimeProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}
