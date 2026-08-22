import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  type DesktopConversationStateStoreLike,
  type DesktopFirstSendClaim,
  DesktopMemoryService,
  DesktopRuntimeService,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
  type DesktopQueuedInput,
  type PreparedMemorySourceInvalidation,
} from "../../src/daemon/index.js";
import type { JsonObject, RuntimeUserInput } from "../../src/daemon/protocol.js";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

test("session delete is blocked when lifecycle prepare cannot become durable", async (context) => {
  const fixture = await createFixture("prepare-failure");
  const canonical = await realpath(fixture.workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({
    env: fixture.env,
    execute: async () => undefined,
  });
  const memory = new PrepareFailingMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    memoryService: memory,
    conversationStateStore: new NoopConversationStateStore(),
    env: fixture.env,
  });
  context.after(async () => {
    await desktop.close();
    memory.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sessionId = await createSession(desktop, fixture.workspace);
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.delete", { workspacePath: fixture.workspace, sessionId }),
    ),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.INTERNAL_ERROR,
  );
  const retained = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.get", { workspacePath: fixture.workspace, sessionId }),
    ),
  );
  assert.equal(asRecord(retained["session"])["sessionId"], sessionId);
});

test("session delete succeeds after prepare while failed lifecycle apply stays durable", async (context) => {
  const fixture = await createFixture("apply-deferred");
  const canonical = await realpath(fixture.workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(canonical);
  const degraded: string[] = [];
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const memory = new CommitFailingMemoryService({
    picoHome: fixture.picoHome,
    repositoryBusyTimeoutMs: 1,
    publish: () => undefined,
    onDegraded: (event) => degraded.push(event.code),
  });
  const runtime = new WorkspaceRuntimeService({
    env: fixture.env,
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    memoryService: memory,
    conversationStateStore: new NoopConversationStateStore(),
    env: fixture.env,
  });
  context.after(async () => {
    await desktop.close();
    memory.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sessionId = await createSession(desktop, fixture.workspace);
  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  const source = repository.createSource({
    sourceId: "desktop-delete-source",
    sessionId,
    digest: "sha256:desktop-delete",
  });
  repository.createProposal({
    proposalId: "desktop-delete-proposal",
    kind: "project_fact",
    title: "Pending lifecycle proposal",
    content: "Pending body",
    reason: "Session deletion test",
    sourceId: source.sourceId,
  });
  repository.close();
  const deleted = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.delete", { workspacePath: fixture.workspace, sessionId }),
    ),
  );
  assert.deepEqual(deleted, { sessionId, deleted: true });
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.get", { workspacePath: fixture.workspace, sessionId }),
    ),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.NOT_FOUND,
  );
  const durable = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  assert.equal(
    durable.listJobs({ type: "source-lifecycle-invalidation", statuses: ["running"] }).length,
    1,
  );
  durable.close();
  assert.deepEqual(degraded, ["lifecycle_deferred"]);

  memory.close();
  const restarted = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  restarted.list(fixture.workspace, { workspacePath: fixture.workspace, limit: 1 });
  restarted.close();
  const settled = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  context.after(() => settled.close());
  assert.equal(settled.getSource(source.sourceId)?.availability, "unavailable");
  assert.equal(settled.getProposal("desktop-delete-proposal")?.status, "deleted");
  assert.equal(
    settled.listJobs({ type: "source-lifecycle-invalidation", statuses: ["succeeded"] }).length,
    1,
  );
});

test("a delete failure after destructive work starts still commits lifecycle invalidation", async (context) => {
  const fixture = await createFixture("partial-delete-failure");
  const canonical = await realpath(fixture.workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(canonical);
  const memory = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  const runtime = new WorkspaceRuntimeService({
    env: fixture.env,
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    memoryService: memory,
    conversationStateStore: new FailingClearConversationStateStore(),
    env: fixture.env,
  });
  context.after(async () => {
    await desktop.close();
    memory.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const sessionId = await createSession(desktop, fixture.workspace);
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  const source = repository.createSource({
    sourceId: "partial-delete-source",
    sessionId,
    digest: "sha256:partial-delete",
  });
  repository.createProposal({
    proposalId: "partial-delete-proposal",
    kind: "reference",
    title: "Partial delete proposal",
    content: "Must not survive an ambiguous delete",
    reason: "Privacy-first lifecycle",
    sourceId: source.sourceId,
  });
  repository.close();

  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.delete", { workspacePath: fixture.workspace, sessionId }),
    ),
    /clear queued failed/u,
  );
  const verify = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  context.after(() => verify.close());
  assert.equal(verify.getSource(source.sourceId)?.availability, "unavailable");
  assert.equal(verify.getProposal("partial-delete-proposal")?.status, "deleted");
  assert.equal(
    verify.listJobs({ type: "source-lifecycle-invalidation", statuses: ["succeeded"] }).length,
    1,
  );
});

test("a prepared lifecycle job does not invalidate a Session whose deletion never committed", async (context) => {
  const fixture = await createFixture("prepared-recovery");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  withWorkspaceSqliteLease(paths.workspace.root, (lease) =>
    lease.transaction("write", () => {
      lease.database
        .prepare(
          `INSERT INTO sessions (
             session_id, work_dir, created_at, updated_at
           ) VALUES ('recovery-session', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(fixture.workspace);
    }),
  );
  const repository = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  const source = repository.createSource({
    sourceId: "recovery-source",
    sessionId: "recovery-session",
    digest: "sha256:recovery",
  });
  repository.createFact({
    factId: "approved-recovery-fact",
    kind: "project_fact",
    title: "Approved fact",
    content: "Retained after source invalidation",
    sourceId: source.sourceId,
  });
  repository.createProposal({
    proposalId: "pending-recovery-proposal",
    kind: "reference",
    title: "Pending fact",
    content: "Must be deleted",
    reason: "Prepared lifecycle recovery",
    sourceId: source.sourceId,
  });
  repository.close();

  const first = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  first.prepareSessionSourceInvalidation(fixture.workspace, "recovery-session", {
    availability: "unavailable",
    code: "session_deleted",
  });
  first.close();

  const restarted = new DesktopMemoryService({
    picoHome: fixture.picoHome,
    publish: () => undefined,
  });
  context.after(() => restarted.close());
  restarted.list(fixture.workspace, { workspacePath: fixture.workspace, limit: 1 });
  const verify = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  context.after(() => verify.close());
  assert.equal(verify.getSource(source.sourceId)?.availability, "available");
  assert.equal(verify.getProposal("pending-recovery-proposal")?.status, "pending");
  assert.equal(verify.getFact("approved-recovery-fact")?.state, "active");
  assert.equal(
    verify.getFact("approved-recovery-fact")?.content,
    "Retained after source invalidation",
  );
  assert.equal(
    verify.listJobs({ type: "source-lifecycle-invalidation", statuses: ["cancelled"] })[0]
      ?.errorCode,
    "lifecycle_prepare_aborted",
  );
});

class PrepareFailingMemoryService extends DesktopMemoryService {
  override prepareSessionSourceInvalidation(): PreparedMemorySourceInvalidation {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INTERNAL_ERROR, "memory prepare failed");
  }
}

class CommitFailingMemoryService extends DesktopMemoryService {
  private readonly reportDeferred: NonNullable<
    ConstructorParameters<typeof DesktopMemoryService>[0]["onDegraded"]
  >;

  constructor(options: ConstructorParameters<typeof DesktopMemoryService>[0]) {
    super(options);
    this.reportDeferred = options.onDegraded ?? (() => undefined);
  }

  override commitSessionSourceInvalidation(prepared: PreparedMemorySourceInvalidation): void {
    this.reportDeferred({
      code: "lifecycle_deferred",
      workspaceId: prepared.workspaceId,
      operationId: prepared.jobId,
      error: new Error("simulated lifecycle commit failure"),
    });
  }
}

class NoopConversationStateStore implements DesktopConversationStateStoreLike {
  async listQueued(): Promise<DesktopQueuedInput[]> {
    return [];
  }

  async enqueue(
    workspacePath: string,
    sessionId: string,
    input: RuntimeUserInput,
  ): Promise<DesktopQueuedInput> {
    return { queueId: "unused", workspacePath, sessionId, input, createdAt: 0 };
  }

  async removeQueued(): Promise<void> {}

  async clearQueued(): Promise<void> {}

  async getIdempotent(): Promise<undefined> {
    return undefined;
  }

  async getFirstSendClaim(): Promise<undefined> {
    return undefined;
  }

  async claimFirstSend(
    workspacePath: string,
    key: string,
    sessionId: string,
    requestFingerprint: string,
  ): Promise<DesktopFirstSendClaim> {
    return { workspacePath, key, sessionId, requestFingerprint, createdAt: 0 };
  }

  async rememberIdempotent(
    _workspacePath: string,
    _key: string,
    _requestFingerprint: string,
    _result: JsonObject,
  ): Promise<void> {}
}

class FailingClearConversationStateStore extends NoopConversationStateStore {
  override async clearQueued(): Promise<void> {
    throw new Error("clear queued failed");
  }
}

async function createSession(
  desktop: DesktopRuntimeService,
  workspacePath: string,
): Promise<string> {
  const created = asRecord(
    await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath, title: "Memory" }),
    ),
  );
  const sessionId = asRecord(created["session"])["sessionId"];
  assert.equal(typeof sessionId, "string");
  return sessionId as string;
}

async function createFixture(name: string): Promise<{
  readonly root: string;
  readonly picoHome: string;
  readonly workspace: string;
  readonly env: Readonly<Record<string, string>>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-lifecycle-${name}-`));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(picoHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeDesktopModelRouting(picoHome);
  return {
    root,
    picoHome,
    workspace,
    env: { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
