import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
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
  const settings = service.getSettings(fixture.workspace).settings;
  const quality = service.updateSettings(fixture.workspace, {
    workspacePath: fixture.workspace,
    expectedVersion: settings.version,
    idempotencyKey: "review-mode-quality",
    reviewMode: "quality",
  });
  assert.equal(quality.settings.reviewMode, "quality");
  assert.equal(quality.reviewBudget.mode, "quality");
  assert.equal(quality.reviewBudget.allowed, true);
  assert.equal(quality.settings.enabled, true);
  assert.equal(quality.settings.injectionEnabled, true);
  assert.deepEqual(
    service.updateSettings(fixture.workspace, {
      workspacePath: fixture.workspace,
      expectedVersion: settings.version,
      idempotencyKey: "review-mode-quality",
      reviewMode: "quality",
    }),
    quality,
  );
  const proposalOff = service.updateSettings(fixture.workspace, {
    workspacePath: fixture.workspace,
    expectedVersion: quality.settings.version,
    idempotencyKey: "review-mode-eco-proposals-off",
    autoPropose: false,
    reviewMode: "eco",
  });
  assert.equal(proposalOff.settings.autoPropose, false);
  assert.equal(proposalOff.settings.reviewMode, "eco");
  assert.equal(proposalOff.reviewBudget.mode, "eco");
  assert.equal(proposalOff.reviewBudget.allowed, false);
  assert.equal(proposalOff.reviewBudget.reason, "eco-mode");
  assert.equal(proposalOff.reviewBudget.maxCalls, 0);
  assert.equal(proposalOff.settings.enabled, true);
  assert.equal(proposalOff.settings.injectionEnabled, true);
  assertRuntimeError(
    () =>
      service.updateSettings(fixture.workspace, {
        workspacePath: fixture.workspace,
        expectedVersion: proposalOff.settings.version,
        idempotencyKey: "reject-auto-commit",
        autoCommit: true,
      } as never),
    RUNTIME_ERROR_CODES.INVALID_PARAMS,
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

test("Desktop memory settings expose only rolling actual terminal review usage", async (context) => {
  const fixture = await createFixture("review-budget");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  let clock = new Date("2026-07-21T11:00:00.000Z");
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
    now: () => clock,
  });
  const complete = (type: string, suffix: string, modelCalls: number) => {
    const job = repository.createJob({
      type,
      terminalEventId: `terminal-${suffix}`,
      extractorVersion: "budget-observability-v1",
      cursor: { sessionId: `session-${suffix}` },
    });
    repository.updateJob({
      jobId: job.jobId,
      expectedVersion: job.version,
      status: "succeeded",
      modelCalls,
      inputTokens: modelCalls * 120,
      outputTokens: modelCalls * 30,
      costUsd: modelCalls * 0.0125,
      idempotencyKey: `complete-${suffix}`,
    });
  };
  complete("terminal-extraction", "actual", 8);
  complete("future-terminal-extraction", "unrelated", 50);
  clock = new Date("2026-07-20T09:00:00.000Z");
  complete("terminal-extraction", "expired", 20);
  repository.close();

  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    now: () => Date.parse("2026-07-22T10:00:00.000Z"),
    publish: () => undefined,
  });
  context.after(() => service.close());

  const result = service.getSettings(fixture.workspace);
  assert.deepEqual(result.reviewBudget, {
    mode: "balanced",
    allowed: false,
    reason: "budget-exhausted",
    calls: 8,
    inputTokens: 960,
    outputTokens: 240,
    costUsd: 0.1,
    maxCalls: 8,
    maxInputTokens: 16_000,
    maxOutputTokens: 2_000,
    maxCostUsd: 0.1,
    nextRecoveryAt: "2026-07-22T11:00:00.000Z",
  });
  assert.equal("databasePath" in result.reviewBudget, false);
  assert.equal("content" in result.reviewBudget, false);
});

test("edited approval is one atomic CAS and never activates the original body", async (context) => {
  const fixture = await createFixture("atomic-review");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const proposal = repository.createProposal({
    proposalId: "proposal-atomic",
    kind: "reference",
    title: "Original title",
    content: "Original body",
    reason: "Original reason",
  });
  repository.close();

  let disconnect = true;
  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => {
      if (disconnect) throw new Error("renderer disconnected");
    },
  });
  context.after(() => service.close());

  assertRuntimeError(
    () =>
      service.resolveReview(fixture.workspace, {
        workspacePath: fixture.workspace,
        proposalId: proposal.proposalId,
        resolution: "accepted",
        expectedVersion: proposal.version + 1,
        idempotencyKey: "atomic-stale",
        patch: { title: "Edited title", content: "Edited body" },
      }),
    RUNTIME_ERROR_CODES.CONFLICT,
  );
  assert.equal(
    service.listReviews(fixture.workspace, {
      workspacePath: fixture.workspace,
      statuses: ["pending"],
    }).proposals.length,
    1,
  );
  assert.equal(
    service.list(fixture.workspace, { workspacePath: fixture.workspace }).facts.length,
    0,
  );

  assertRuntimeError(
    () =>
      service.resolveReview(fixture.workspace, {
        workspacePath: fixture.workspace,
        proposalId: proposal.proposalId,
        resolution: "accepted",
        expectedVersion: proposal.version,
        idempotencyKey: "atomic-approve",
        patch: {
          kind: "project_fact",
          title: "Edited title",
          content: "Edited body",
          reason: "Human corrected the proposal",
          confidence: 1,
        },
      }),
    RUNTIME_ERROR_CODES.INTERNAL_ERROR,
  );
  disconnect = false;

  const verify = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  context.after(() => verify.close());
  const accepted = verify.getProposal(proposal.proposalId)!;
  const fact = verify.getFact(accepted.resolvedFactId!)!;
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.version, proposal.version + 1);
  assert.equal(accepted.content, "Edited body");
  assert.equal(fact.kind, "project_fact");
  assert.equal(fact.title, "Edited title");
  assert.equal(fact.content, "Edited body");
  assert.equal(
    verify
      .listFacts({ states: ["active"], limit: 500 })
      .some((item) => item.content === "Original body"),
    false,
  );
  assert.deepEqual(
    verify.listMutations({ entityId: fact.factId }).map((mutation) => mutation.action),
    ["fact.created"],
  );
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

test("session lifecycle compensation invalidates more than 500 sources without overriding success", async (context) => {
  const fixture = await createFixture("lifecycle-pagination");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  for (let index = 0; index < 510; index++) {
    const suffix = index.toString().padStart(4, "0");
    const source = repository.createSource({
      sourceId: `bulk-source-${suffix}`,
      sessionId: "bulk-session",
      digest: `sha256:bulk-${suffix}`,
    });
    repository.createProposal({
      proposalId: `bulk-proposal-${suffix}`,
      kind: "project_fact",
      title: `Bulk ${suffix}`,
      content: `Body ${suffix}`,
      reason: "Lifecycle pagination fixture",
      sourceId: source.sourceId,
    });
  }
  repository.close();

  const degraded: string[] = [];
  let failFirstPublish = true;
  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => {
      if (failFirstPublish) {
        failFirstPublish = false;
        throw new Error("notification transport unavailable");
      }
    },
    onDegraded: (event) => degraded.push(event.code),
  });
  context.after(() => service.close());
  assert.doesNotThrow(() =>
    service.invalidateSessionSources(fixture.workspace, "bulk-session", {
      availability: "unavailable",
      code: "session_deleted",
    }),
  );
  assert.deepEqual(degraded, ["notification_delivery_deferred"]);

  // Any later memory access retries the durable lifecycle job.
  service.list(fixture.workspace, { workspacePath: fixture.workspace, limit: 1 });
  const inspection = new Database(paths.workspace.memoryDatabase, {
    readonly: true,
    fileMustExist: true,
  });
  context.after(() => inspection.close());
  assert.deepEqual(
    inspection
      .prepare(
        "SELECT availability, COUNT(*) AS count FROM memory_sources WHERE session_id = ? GROUP BY availability",
      )
      .all("bulk-session"),
    [{ availability: "unavailable", count: 510 }],
  );
  assert.deepEqual(
    inspection
      .prepare(
        "SELECT status, COUNT(*) AS count FROM memory_proposals WHERE proposal_id LIKE 'bulk-proposal-%' GROUP BY status",
      )
      .all(),
    [{ status: "deleted", count: 510 }],
  );
  assert.deepEqual(
    inspection
      .prepare(
        "SELECT status, COUNT(*) AS count FROM memory_jobs WHERE type = 'source-lifecycle-invalidation' GROUP BY status",
      )
      .all(),
    [{ status: "succeeded", count: 1 }],
  );
});

test("busy secure-delete forget durably outboxes a body-free notification", async (context) => {
  const fixture = await createFixture("forget-outbox");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const secret = "forget-outbox-sensitive-body";
  const fact = repository.createFact({
    factId: "forget-outbox-fact",
    kind: "reference",
    title: secret,
    content: secret,
  });
  repository.close();

  const events: Array<{ readonly topic: string; readonly payload: Record<string, unknown> }> = [];
  const degraded: string[] = [];
  const service = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    repositoryBusyTimeoutMs: 1,
    publish: (_workspacePath, topic, payload) => events.push({ topic, payload }),
    onDegraded: (event) => degraded.push(event.code),
  });
  context.after(() => service.close());
  service.get(fixture.workspace, fact.factId);
  const reader = holdFactReadSnapshot(paths.workspace.memoryDatabase, fact.factId, secret);
  assertRuntimeError(
    () =>
      service.forget(fixture.workspace, {
        workspacePath: fixture.workspace,
        factId: fact.factId,
        expectedVersion: fact.version,
        idempotencyKey: "forget-outbox-request",
      }),
    RUNTIME_ERROR_CODES.CONFLICT,
  );
  assert.equal(
    events.some((event) => event.topic === "memory.forgotten"),
    true,
  );
  assert.ok(events.every((event) => !("content" in event.payload) && !("title" in event.payload)));
  releaseReadSnapshot(reader);

  const replay = service.forget(fixture.workspace, {
    workspacePath: fixture.workspace,
    factId: fact.factId,
    expectedVersion: fact.version,
    idempotencyKey: "forget-outbox-request",
  });
  assert.equal(replay.fact.state, "forgotten");
  const inspection = new Database(paths.workspace.memoryDatabase, {
    readonly: true,
    fileMustExist: true,
  });
  context.after(() => inspection.close());
  assert.deepEqual(
    inspection
      .prepare(
        "SELECT status, COUNT(*) AS count FROM memory_jobs WHERE type = 'notification.memory.forgotten' GROUP BY status",
      )
      .all(),
    [{ status: "succeeded", count: 1 }],
  );
  assert.ok(degraded.includes("notification_delivery_deferred"));
});

test("context preview reuses query-aware recall and reports the 3-fact/320-token hard budget", async (context) => {
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
    ["pinned", "correction"],
  );
  assert.equal(preview.budget.maxFacts, 3);
  assert.equal(preview.budget.maxTokens, 320);
  assert.equal(preview.budget.usedFacts, 2);
  assert.ok(preview.budget.usedTokens <= 320);
  assert.equal(preview.budget.truncated, false);
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

function holdFactReadSnapshot(
  databasePath: string,
  factId: string,
  expectedContent: string,
): Database.Database {
  const reader = new Database(databasePath, { readonly: true, fileMustExist: true });
  reader.pragma("busy_timeout = 0");
  reader.exec("BEGIN");
  const row = reader.prepare("SELECT content FROM memory_facts WHERE fact_id = ?").get(factId) as {
    readonly content: string;
  };
  assert.equal(row.content, expectedContent);
  return reader;
}

function releaseReadSnapshot(reader: Database.Database): void {
  if (!reader.open) return;
  reader.exec("ROLLBACK");
  reader.close();
}
