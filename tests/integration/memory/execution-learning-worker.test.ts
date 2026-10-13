import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningJob,
  ExecutionVerificationResult,
  ExecutionVerificationTicket,
} from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { ExecutionLearningWorker } from "../../../packages/pico-host/src/execution-learning-worker.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const source = (eventId: string, runId = "fixture-run", sessionId = "fixture-session") => ({
  eventId,
  runId,
  sessionId,
  turnId: "fixture-turn",
});

async function seed(
  repository: SqliteMemoryItemStore,
  workDir: string,
  now: number,
  kind: "verify" | "reflect" = "verify",
) {
  const store = repository.executionLearning;
  const settings = await repository.readSettings("workspace");
  const epoch = await store.advanceExecutionLearningInput("workspace");
  const admission = {
    admissionId: "fixture-admission",
    workspaceKey: "workspace",
    workDir,
    sessionId: "fixture-session",
    runId: "fixture-run",
    settingsVersion: settings.version,
    deletionRevision: await repository.readDeletionRevision(),
    ...epoch,
    createdAt: now,
  };
  await store.admitExecutionLearning(admission);
  const claim: ExecutionAcceptanceClaim = {
    candidateId: "fixture-candidate",
    revision: 1,
    failureKey: "fixture-failure",
    predicateId: "command-conditions.v1",
    admission,
    target: {
      targetId: "fixture-target",
      label: "CheckEntry",
      kind: "command",
      command: "node check.cjs",
      argv: [],
      cwd: workDir,
      scopeHash: hash(workDir),
      entryFiles: [{ path: join(workDir, "check.cjs"), hash: hash("check") }],
    },
    claimHash: hash("fixture-claim"),
    conditions: [{ kind: "cwd", path: workDir }],
    recipe: [],
    failedTestIds: [],
    failure: source("failure"),
    createdAt: now,
  };
  await store.saveExecutionLearningClaim(claim);
  const observation = {
    complete: true,
    matches: true,
    fingerprint: hash("fixture-conditions"),
    facts: [],
  };
  const ticket: ExecutionVerificationTicket = {
    ticketId: "fixture-ticket",
    candidateId: claim.candidateId,
    claimRevision: claim.revision,
    claimHash: claim.claimHash,
    admissionId: admission.admissionId,
    sessionId: admission.sessionId,
    runId: admission.runId,
    toolCallId: "success",
    preparedEventId: "prepared-success",
    argumentsHash: hash("success-arguments"),
    inputEpoch: admission.inputEpoch,
    before: observation,
    createdAt: now + 1,
  };
  const result: ExecutionVerificationResult = {
    ticketId: ticket.ticketId,
    source: source("success"),
    after: observation,
    complete: true,
    exitCode: 0,
    settledAt: now + 2,
  };
  if (kind === "verify") {
    await store.registerExecutionVerification(ticket);
    await store.settleExecutionVerification(result);
  }
  const job: ExecutionLearningJob = {
    jobId: "fixture-job",
    workspaceKey: admission.workspaceKey,
    sessionId: admission.sessionId,
    runId: admission.runId,
    candidateId: claim.candidateId,
    ...(kind === "verify" ? { ticketId: ticket.ticketId } : {}),
    kind,
    state: "ready",
    inputEpoch: admission.inputEpoch,
    createdAt: now + 2,
    updatedAt: now + 2,
    leaseUntil: 0,
    fencingToken: 0,
  };
  await store.enqueueExecutionLearningJob(job);
  return { claim, ticket, result, job };
}

for (const kind of ["verify", "reflect"] as const)
  test(`存量原生${kind} job重启后仅跳过，不申请模型或发布`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-retired-native-"));
    const path = join(root, "memory.sqlite");
    const repository = new SqliteMemoryItemStore(path);
    const now = Date.now();
    const fixture = await seed(repository, root, now, kind);
    // Historical jobs remain readable even though new native enqueue is retired.
    const db = new DatabaseSync(path);
    const j = fixture.job;
    db.prepare(
      "INSERT OR REPLACE INTO execution_learning_jobs(job_id,workspace_key,candidate_id,state,lease_until,fencing_token,updated_at,record_json) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      j.jobId,
      j.workspaceKey,
      j.candidateId,
      j.state,
      j.leaseUntil,
      j.fencingToken,
      j.updatedAt,
      JSON.stringify(j),
    );
    db.close();
    let modelCalls = 0;
    const worker = new ExecutionLearningWorker({
      picoHome: root,
      store: repository.executionLearning,
      taskExperiences: repository.taskExperiences,
      idleMs: 0,
      pollMs: 60000,
      taskExperienceModelFactory: async () => {
        modelCalls++;
        throw new Error("native cannot reflect");
      },
    });
    t.after(async () => {
      await worker.close();
      repository.close();
      await rm(root, { recursive: true, force: true });
    });
    const foreground = worker.foregroundRun("workspace");
    assert.equal(await worker.flushOnce(), false);
    foreground.release();
    await worker.flushOnce();
    await worker.drain();
    assert.equal(modelCalls, 0);
    assert.equal((await repository.listItems({ workspaceKey: "workspace" })).length, 0);
    assert.notEqual(
      (await repository.executionLearning.readExecutionLearningCandidate(fixture.claim.candidateId))
        ?.state,
      "saved",
    );
  });
