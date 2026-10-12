import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningJob,
  ExecutionVerificationResult,
  ExecutionVerificationTicket,
  RuntimeToolResultRecordedEvent,
  RuntimeToolStartedEvent,
} from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import {
  acquireExecutionLearningWorker,
  closeExecutionLearningWorker,
  ExecutionLearningWorker,
  getExecutionLearningWorker,
} from "../../../packages/pico-host/src/execution-learning-worker.js";

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

test(
  "native execution receipts survive restart and foreground input; the worker publishes once without a model or Session owner",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-learning-native-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    const script =
      "if (!require('fs').existsSync('ready.flag')) process.exit(1); console.log('PASS');";
    await writeFile(join(workDir, "check.cjs"), script);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    // This fixture exercises native process collection, without user-fact extraction.
    lifecycle.beginDrain();
    const sessions = ["native-failure", "native-success"];
    let repository = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    t.after(async () => {
      await closeExecutionLearningWorker(picoHome);
      await lifecycle.close();
      for (const sessionId of sessions)
        await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      repository.close();
      await rm(root, { recursive: true, force: true });
    });
    const execute = async (sessionId: string, toolCallId: string) => {
      let step = 0;
      await executeAgentRuntime(
        {
          prompt: "检查项目入口。",
          dir: workDir,
          sessionSelection: { mode: "new", sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          permissionMode: "full-access",
          allowedTools: ["bash"],
        },
        {
          picoHome,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          reporter: new SilentReporter(),
          provider: {
            async generate() {
              return step++ === 0
                ? {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: toolCallId,
                        name: "bash",
                        arguments: JSON.stringify({ command: "node check.cjs" }),
                      },
                    ],
                  }
                : { role: "assistant" as const, content: "检查已结束。" };
            },
          },
          atomicMemoryModelFactory: async () => {
            throw new Error("No model expected");
          },
        },
      );
      const events = globalSessionManager.get(sessionId, workDir, { picoHome })!.runtimeEventStore!;
      const slice = await events.readSessionEntriesOfKinds(sessionId, [
        "tool.started",
        "tool.result.recorded",
      ]);
      const start = slice.entries.find(
        ({ event }) => event.kind === "tool.started" && event.refs?.toolCallId === toolCallId,
      )!.event as RuntimeToolStartedEvent;
      const result = slice.entries.find(
        ({ event }) =>
          event.kind === "tool.result.recorded" && event.refs.toolCallId === toolCallId,
      )!.event as RuntimeToolResultRecordedEvent;
      const operation = await events.readToolOperation(sessionId, result.runId, toolCallId);
      assert.equal(operation?.state, "settled");
      assert.equal(operation?.outcomeEventId, result.eventId);
      assert.equal(result.data.executionFacts?.kind, "foreground_process");
      assert.equal(result.data.executionFacts?.outputIncomplete, false);
      return { start, result };
    };
    const failure = await execute(sessions[0]!, "failed");
    assert.equal(failure.result.data.executionFacts!.exitCode, 1);
    const claimAt = Date.now();
    const settings = await repository.readSettings("workspace");
    const firstEpoch =
      await repository.executionLearning.advanceExecutionLearningInput("workspace");
    const admission = {
      admissionId: "native-failure-admission",
      workspaceKey: "workspace",
      workDir,
      sessionId: failure.result.sessionId,
      runId: failure.result.runId,
      settingsVersion: settings.version,
      deletionRevision: await repository.readDeletionRevision(),
      ...firstEpoch,
      createdAt: claimAt,
    };
    await repository.executionLearning.admitExecutionLearning(admission);
    const claim: ExecutionAcceptanceClaim = {
      candidateId: "native-candidate",
      revision: 1,
      failureKey: failure.result.eventId,
      predicateId: "command-conditions.v1",
      admission,
      target: {
        targetId: "native-target",
        label: "CheckEntry",
        kind: "command",
        command: "node check.cjs",
        argv: [],
        cwd: workDir,
        scopeHash: hash(script),
        entryFiles: [{ path: join(workDir, "check.cjs"), hash: hash(script) }],
      },
      claimHash: hash("native-claim"),
      conditions: [{ kind: "file", path: join(workDir, "ready.flag"), hash: hash("ready") }],
      recipe: [],
      failedTestIds: [],
      failure: {
        ...source(failure.result.eventId, failure.result.runId, failure.result.sessionId),
        turnId: failure.result.turnId,
      },
      createdAt: claimAt,
    };
    await repository.executionLearning.saveExecutionLearningClaim(claim);
    await writeFile(join(workDir, "ready.flag"), "ready");
    const success = await execute(sessions[1]!, "passed");
    assert.equal(success.result.data.executionFacts!.exitCode, 0);
    const nextEpoch = await repository.executionLearning.advanceExecutionLearningInput("workspace");
    const verificationAdmission = {
      ...admission,
      ...nextEpoch,
      admissionId: "native-verification-admission",
      sessionId: success.result.sessionId,
      runId: success.result.runId,
      createdAt: Date.parse(success.start.at),
    };
    await repository.executionLearning.admitExecutionLearning(verificationAdmission);
    const observation = {
      complete: true,
      matches: true,
      fingerprint: hash("ready"),
      facts: [{ path: join(workDir, "ready.flag"), hash: hash("ready") }],
    };
    const ticket: ExecutionVerificationTicket = {
      ticketId: "native-ticket",
      candidateId: claim.candidateId,
      claimRevision: 1,
      claimHash: claim.claimHash,
      admissionId: verificationAdmission.admissionId,
      sessionId: success.result.sessionId,
      runId: success.result.runId,
      toolCallId: "passed",
      preparedEventId: success.start.eventId,
      argumentsHash: success.start.data.argumentsHash,
      inputEpoch: nextEpoch.inputEpoch,
      before: observation,
      createdAt: Date.parse(success.start.at),
    };
    await repository.executionLearning.registerExecutionVerification(ticket);
    await repository.executionLearning.settleExecutionVerification({
      ticketId: ticket.ticketId,
      source: {
        ...source(success.result.eventId, success.result.runId, success.result.sessionId),
        turnId: success.result.turnId,
      },
      after: observation,
      complete: true,
      exitCode: 0,
      settledAt: Date.parse(success.result.at),
    });
    const now = Date.now();
    await repository.executionLearning.enqueueExecutionLearningJob({
      jobId: "native-job",
      workspaceKey: "workspace",
      candidateId: claim.candidateId,
      sessionId: ticket.sessionId,
      runId: ticket.runId,
      ticketId: ticket.ticketId,
      kind: "verify",
      state: "ready",
      inputEpoch: nextEpoch.inputEpoch,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
      fencingToken: 0,
    });
    const abandoned = await repository.executionLearning.claimExecutionLearningJob(
      "crashed-host",
      now - 10,
      1,
    );
    assert.ok(abandoned);
    repository.close();
    repository = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const options = {
      picoHome,
      store: repository.executionLearning,
      idleMs: 0,
      pollMs: 60_000,
      validateEvidence: async ({
        ticket: receivedTicket,
        result,
      }: Parameters<
        import("../../../packages/pico-host/src/execution-learning-worker.js").ExecutionLearningWorkerOptions["validateEvidence"]
      >[0]) => {
        assert.equal(receivedTicket.preparedEventId, success.start.eventId);
        assert.equal(result.source.eventId, success.result.eventId);
        assert.equal(success.result.partial, false);
        assert.equal(success.result.data.recovery, undefined);
        assert.equal(success.result.data.executionFacts!.exitCode, result.exitCode);
        entered.resolve();
        await release.promise;
        return {
          status: "pass" as const,
          content: "CheckEntry satisfied its frozen file conditions and exited successfully.",
        };
      },
      modelFactory: async () => {
        throw new Error("Verification must not acquire a model");
      },
    };
    const first = acquireExecutionLearningWorker(options),
      second = acquireExecutionLearningWorker(options);
    assert.equal(first.worker, second.worker);
    const foreground1 = first.worker.foregroundRun("workspace"),
      foreground2 = first.worker.foregroundRun("workspace");
    foreground1.release();
    assert.equal(await first.worker.flushOnce(), false, "the second Run still owns the foreground");
    foreground2.release();
    await repository.executionLearning.advanceExecutionLearningInput("workspace");
    const processing = first.worker.flushOnce();
    await entered.promise;
    first.release();
    second.release();
    assert.equal(
      getExecutionLearningWorker(picoHome),
      first.worker,
      "Run release does not close background work",
    );
    assert.equal((await repository.listItems({ workspaceKey: "workspace" })).length, 0);
    release.resolve();
    assert.equal(await processing, true);
    assert.equal(await first.worker.flushOnce(), false);
    const saved = await repository.executionLearning.readExecutionLearningCandidate(
      claim.candidateId,
    );
    assert.equal(saved?.state, "saved");
    const items = await repository.listItems({ workspaceKey: "workspace" });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.sourceType, "execution-validated");
    assert.deepEqual(
      items[0]!.sources.map((item) => item.eventId).sort(),
      [failure.result.eventId, success.result.eventId].sort(),
    );
  },
);

test(
  "foreground preemption and bounded shutdown cancel reflection after its persistent budget debit",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-learning-cancel-"));
    const path = join(root, "memory.sqlite");
    const repository = new SqliteMemoryItemStore(path);
    let now = 10_000;
    const fixture = await seed(repository, root, now, "reflect");
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const requests: AbortSignal[] = [];
    let calls = 0,
      disposals = 0,
      connectionClosed = false;
    const worker = new ExecutionLearningWorker({
      picoHome: root,
      store: repository.executionLearning,
      idleMs: 0,
      pollMs: 60_000,
      leaseMs: 100,
      shutdownGraceMs: 10,
      now: () => now,
      validateEvidence: async () => {
        throw new Error("Reflection cannot verify a claim");
      },
      modelFactory: async () => ({
        model: {
          async call(request) {
            assert.equal(request.sourceTools, undefined);
            assert.ok(request.signal);
            requests.push(request.signal);
            assert.equal(
              budgetCount(path),
              calls + 1,
              "the debit must be committed before model call",
            );
            entered[calls++]!.resolve();
            return new Promise<string>(() => {}); // A provider that ignores cancellation.
          },
        },
        dispose: () => {
          disposals++;
        },
      }),
      onClose: () => {
        repository.close();
        connectionClosed = true;
      },
    });
    t.after(async () => {
      await worker.close();
      await rm(root, { recursive: true, force: true });
    });
    const first = worker.flushOnce();
    const firstStage = await Promise.race([
      entered[0]!.promise.then(() => "entered"),
      first.then(() => "completed"),
    ]);
    assert.equal(
      firstStage,
      "entered",
      JSON.stringify(
        await repository.executionLearning.readExecutionLearningCandidate(
          fixture.claim.candidateId,
        ),
      ),
    );
    const foreground = worker.foregroundRun("workspace");
    await first;
    assert.equal(requests[0]!.aborted, true);
    assert.equal(disposals, 1);
    assert.equal(budgetCount(path), 1);
    assert.equal(
      (await repository.executionLearning.readExecutionLearningCandidate(fixture.claim.candidateId))
        ?.hypothesis,
      undefined,
    );
    assert.equal(await worker.flushOnce(), false);
    foreground.release();
    now += 101;
    const second = worker.flushOnce();
    await entered[1]!.promise;
    await worker.close();
    await second;
    assert.equal(requests[1]!.aborted, true);
    assert.equal(connectionClosed, true);
    assert.equal(disposals, 2);
    assert.equal(calls, 2);
    assert.equal(budgetCount(path), 2);
    const resumed = new SqliteMemoryItemStore(path);
    assert.equal(
      await resumed.executionLearning.reserveExecutionLearningModelAttempt(
        fixture.claim.failureKey,
        "workspace",
        now,
      ),
      false,
    );
    assert.equal((await resumed.listItems({ workspaceKey: "workspace" })).length, 0);
    resumed.close();
  },
);

test(
  "a worker losing its job fence cannot publish or surface a foreground error",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-learning-fence-"));
    const path = join(root, "memory.sqlite");
    const repository = new SqliteMemoryItemStore(path),
      competing = new SqliteMemoryItemStore(path);
    const now = 10_000;
    const fixture = await seed(repository, root, now);
    const errors: unknown[] = [];
    let replacement: ExecutionLearningJob | undefined;
    const worker = new ExecutionLearningWorker({
      picoHome: root,
      store: repository.executionLearning,
      idleMs: 0,
      pollMs: 60_000,
      leaseMs: 100,
      now: () => now,
      onError: (error) => errors.push(error),
      validateEvidence: async () => {
        replacement = await competing.executionLearning.claimExecutionLearningJob(
          "replacement",
          now + 101,
          100,
        );
        assert.ok(replacement);
        return { status: "pass", content: "CheckEntry satisfied its frozen conditions." };
      },
    });
    t.after(async () => {
      await worker.close();
      repository.close();
      competing.close();
      await rm(root, { recursive: true, force: true });
    });
    assert.equal(await worker.flushOnce(), true);
    assert.deepEqual(errors, []);
    assert.equal((await repository.listItems({ workspaceKey: "workspace" })).length, 0);
    assert.equal(
      (await repository.executionLearning.readExecutionLearningCandidate(fixture.claim.candidateId))
        ?.state,
      "working",
    );
    await competing.executionLearning.completeExecutionLearningJob({
      jobId: fixture.job.jobId,
      fencingToken: replacement!.fencingToken,
      candidateRevision: fixture.claim.revision,
      content: "CheckEntry satisfied its frozen conditions.",
      now: now + 102,
    });
    assert.equal((await repository.listItems({ workspaceKey: "workspace" })).length, 1);
  },
);

function budgetCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM execution_learning_attempts").get()!.n);
  } finally {
    db.close();
  }
}
