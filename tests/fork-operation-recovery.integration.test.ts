import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPicoCommandRegistry } from "../src/input/pico-command-registry.js";
import { processUserInput } from "../src/input/process-user-input.js";
import { ContentAddressedBlobGarbageCollector } from "../src/storage/blob-garbage-collector.js";
import { FileHistoryBlobStore } from "../src/storage/file-history-blob-store.js";
import {
  ForkOperationConflictError,
  ForkOperationCoordinator,
  type ForkOperationCallbacks,
  type NewForkStorageOperation,
} from "../src/storage/fork-operation-coordinator.js";
import { StorageOperationJournal } from "../src/storage/operation-journal.js";
import { OwnerLease } from "../src/storage/owner-lease.js";
import { StorageDoctor } from "../src/storage/storage-doctor.js";

describe("fork operation manual recovery integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keeps needs_attention visible across restart and retries from its recorded phase", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-operation-retry-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    let blocked = true;
    const journal = new StorageOperationJournal({ workDir });
    const coordinator = new ForkOperationCoordinator({
      journal,
      callbacks: createCallbacks(() => blocked),
    });
    const attention = await coordinator.execute(
      forkInput("retry-after-restart", "retry-target", join(root, "staging", "retry")),
    );
    expect(attention).toMatchObject({
      state: "needs_attention",
      version: 2,
      error: { phase: "prepared", message: expect.stringContaining("target_conflict") as string },
    });

    const restartedJournal = new StorageOperationJournal({ workDir });
    const restartedDoctor = new StorageDoctor({
      workDir,
      fileHistoryDir: join(root, "file-history"),
    });
    for (let scan = 0; scan < 2; scan += 1) {
      await expect(restartedDoctor.scan()).resolves.toMatchObject({
        healthy: false,
        findings: [
          expect.objectContaining({
            code: "operation_needs_attention",
            message: expect.stringContaining("retry-after-restart v2") as string,
          }),
        ],
      });
      await expect(restartedJournal.listNeedsAttention()).resolves.toHaveLength(1);
    }

    blocked = false;
    const restartedCoordinator = new ForkOperationCoordinator({
      journal: restartedJournal,
      callbacks: createCallbacks(() => blocked),
    });
    const completed = await restartedCoordinator.retryNeedsAttention({
      operationId: attention.operationId,
      expectedVersion: attention.version,
      reason: "operator verified the target is now free",
    });
    expect(completed).toMatchObject({
      state: "completed",
      dispositions: [
        {
          action: "retry",
          fromVersion: 2,
          reason: "operator verified the target is now free",
          failure: { phase: "prepared" },
        },
      ],
    });
    expect(completed.error).toBeUndefined();
    await expect(restartedJournal.listNeedsAttention()).resolves.toEqual([]);
    await expect(restartedDoctor.scan()).resolves.not.toMatchObject({
      findings: [expect.objectContaining({ code: "operation_needs_attention" })],
    });
    await expect(
      restartedJournal.advance({
        operationId: completed.operationId,
        expectedVersion: completed.version,
        nextState: "completed",
      }),
    ).rejects.toThrow("Invalid storage operation transition");
  });

  it("aborts once under concurrent disposition and releases the durable target claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-operation-abort-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const journal = new StorageOperationJournal({ workDir });
    const brokenCoordinator = new ForkOperationCoordinator({
      journal,
      callbacks: createMissingBundleCallbacks(),
    });
    const attention = await brokenCoordinator.execute(
      forkInput("abort-owner", "shared-target", join(root, "staging", "owner")),
    );
    expect(attention).toMatchObject({
      state: "needs_attention",
      error: { message: expect.stringContaining("staging_corrupt") as string },
    });

    const input = {
      operationId: attention.operationId,
      expectedVersion: attention.version,
      reason: "operator abandoned the corrupt staged payload",
    };
    const dispositions = await Promise.allSettled([
      brokenCoordinator.abortNeedsAttention(input),
      brokenCoordinator.abortNeedsAttention(input),
    ]);
    expect(dispositions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(dispositions.filter((result) => result.status === "rejected")).toHaveLength(1);

    const aborted = await journal.get(attention.operationId);
    expect(aborted).toMatchObject({
      state: "aborted",
      version: attention.version + 1,
      dispositions: [
        {
          action: "abort",
          fromVersion: attention.version,
          reason: "operator abandoned the corrupt staged payload",
        },
      ],
    });
    if (!aborted) throw new Error("aborted operation disappeared");
    await expect(
      journal.retryNeedsAttention({
        operationId: aborted.operationId,
        expectedVersion: aborted.version,
        reason: "must not reopen an aborted operation",
      }),
    ).rejects.toThrow("not needs_attention");
    await expect(
      journal.advance({
        operationId: aborted.operationId,
        expectedVersion: aborted.version,
        nextState: "aborted",
      }),
    ).rejects.toThrow("Invalid storage operation transition");

    const successor = await new ForkOperationCoordinator({
      journal,
      callbacks: createCallbacks(() => false),
    }).execute(forkInput("successor", "shared-target", join(root, "staging", "successor")));
    expect(successor.state).toBe("completed");
  });

  it("releases a needs_attention CAS root only after an audited abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-operation-abort-gc-"));
    cleanup.push(root);
    const workDirA = join(root, "workspace-a");
    const workDirB = join(root, "workspace-b");
    const fileHistoryDir = join(root, "file-history");
    const blobs = new FileHistoryBlobStore({ baseDir: fileHistoryDir });
    const retained = await blobs.put("retained until explicit abort");
    await utimes(retained.path, new Date(0), new Date(0));
    const journal = new StorageOperationJournal({ workDir: workDirB });
    journal.attachReferenceIndex(fileHistoryDir);
    const prepared = await journal.create({
      kind: "rewind",
      operationId: "abort-gc-root",
      sessionId: "rewind-source",
      mode: "code",
      precondition: {
        sessionLastSeq: 1,
        effectiveHistoryDigest: createHash("sha256").update("history").digest("hex"),
        fileHistoryRevision: 1,
      },
      target: { messageId: "message-1", messageIndex: 0 },
      files: [
        {
          rootId: "workspace",
          relativePath: "src/root.ts",
          before: {
            kind: "file",
            blobSha256: retained.ref.digest,
            sizeBytes: retained.ref.sizeBytes,
            mode: 0o644,
          },
          after: { kind: "missing" },
        },
      ],
    });
    const attention = await journal.advance({
      operationId: prepared.operationId,
      expectedVersion: prepared.version,
      nextState: "needs_attention",
      error: { phase: "prepared", message: "manual conflict" },
    });
    const collector = new ContentAddressedBlobGarbageCollector({
      workDir: workDirA,
      baseDir: fileHistoryDir,
      gracePeriodMs: 0,
      now: () => 120_000,
    });
    await expect(collector.run({ apply: true })).resolves.toMatchObject({
      candidatePaths: [],
      deletedPaths: [],
    });

    const aborted = await journal.abortNeedsAttention({
      operationId: attention.operationId,
      expectedVersion: attention.version,
      reason: "operator chose to release the rewind root",
    });
    expect(aborted).toMatchObject({ state: "aborted", dispositions: [{ action: "abort" }] });
    await expect(collector.run({ apply: true })).resolves.toMatchObject({
      candidatePaths: [retained.path],
      deletedPaths: [retained.path],
    });
    await expect(stat(retained.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out a contended target and continues reconciling later operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-fork-lease-timeout-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const journal = new StorageOperationJournal({ workDir });
    const contended = forkInput("a-contended", "busy-target", join(root, "staging", "busy"));
    const available = forkInput("b-available", "free-target", join(root, "staging", "free"));
    await journal.create(contended);
    await journal.create(available);
    const lease = await OwnerLease.acquire({
      leaseDirectory: targetLeaseDirectory(journal, contended.targetSessionId),
      ownerId: "external-owner",
    });
    const coordinator = new ForkOperationCoordinator({
      journal,
      callbacks: createCallbacks(() => false),
      leaseAcquisitionTimeoutMs: 1_000,
      leaseRetryInitialMs: 5,
      leaseRetryMaxMs: 10,
      random: () => 0.5,
    });

    try {
      const results = await coordinator.reconcileUnfinished({ deadlineAt: Date.now() + 40 });
      expect(results[0]).toMatchObject({
        operationId: "a-contended",
        state: "prepared",
        status: "lease_timeout",
        diagnostic: {
          code: "fork_target_lease_timeout",
          targetSessionId: "busy-target",
          attempts: expect.any(Number) as number,
        },
      });
      expect(results[1]).toEqual({ operationId: "b-available", state: "completed" });
      await expect(journal.get("a-contended")).resolves.toMatchObject({ state: "prepared" });
      await expect(journal.get("b-available")).resolves.toMatchObject({ state: "completed" });
    } finally {
      await lease.release();
    }
  });

  it("aborts lease backoff promptly through AbortSignal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-fork-lease-abort-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const journal = new StorageOperationJournal({ workDir });
    const operation = forkInput("signal-contended", "busy-target", join(root, "staging", "busy"));
    await journal.create(operation);
    const lease = await OwnerLease.acquire({
      leaseDirectory: targetLeaseDirectory(journal, operation.targetSessionId),
      ownerId: "external-owner",
    });
    const coordinator = new ForkOperationCoordinator({
      journal,
      callbacks: createCallbacks(() => false),
      leaseAcquisitionTimeoutMs: 1_000,
      leaseRetryInitialMs: 20,
      leaseRetryMaxMs: 40,
      random: () => 0.5,
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException("stop recovery", "AbortError")),
      20,
    );
    try {
      await expect(
        coordinator.reconcileUnfinished({ signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(timeout);
      await lease.release();
    }
  });

  it("exposes fail-closed list, show, retry, and abort command paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-operation-command-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const stagingDirectory = join(root, "staging", "command-operation");
    await mkdir(workDir, { recursive: true });
    await mkdir(stagingDirectory, { recursive: true });
    await writeFile(join(stagingDirectory, "keep-until-abort"), "staged", "utf8");
    const journal = new StorageOperationJournal({ workDir });
    const prepared = await journal.create(
      forkInput("command-operation", "command-target", stagingDirectory),
    );
    const attention = await journal.advance({
      operationId: prepared.operationId,
      expectedVersion: prepared.version,
      nextState: "needs_attention",
      error: { phase: "prepared", message: "operator must inspect this failure" },
    });
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "test-model",
    });

    const listed = await processUserInput("/operations list", { registry });
    expect(localMessage(listed)).toContain("command-operation · fork · v2");
    const shown = await processUserInput("/operations show command-operation", { registry });
    expect(localMessage(shown)).toContain("Failure reason: operator must inspect this failure");

    const staleRetry = await processUserInput("/operations retry command-operation 1", {
      registry,
    });
    expect(localMessage(staleRetry)).toContain("failed closed");
    await expect(journal.get(attention.operationId)).resolves.toMatchObject({
      state: "needs_attention",
      version: attention.version,
    });

    const aborted = await processUserInput(
      `/operations abort command-operation ${attention.version} operator confirmed abort`,
      { registry },
    );
    expect(localMessage(aborted)).toContain("State: aborted");
    expect(localMessage(aborted)).toContain("Staging cleanup: completed");
    await expect(journal.get(attention.operationId)).resolves.toMatchObject({
      state: "aborted",
      dispositions: [{ action: "abort", reason: "operator confirmed abort" }],
    });
    await expect(stat(stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const immutableRetry = await processUserInput("/operations retry command-operation 3", {
      registry,
    });
    expect(localMessage(immutableRetry)).toContain("failed closed");
  });
});

function createCallbacks(blocked: () => boolean): ForkOperationCallbacks {
  return {
    prepareTargetBundle: async (operation, stagingDirectory) => {
      const stagedBundlePath = join(stagingDirectory, `${operation.operationId}.json`);
      await writeFile(stagedBundlePath, JSON.stringify({ operationId: operation.operationId }));
      return { stagedBundlePath };
    },
    assertTargetAvailable: async () => {
      if (blocked()) {
        throw new ForkOperationConflictError("target remains occupied", "target_conflict");
      }
    },
    assertRuntimeTargetOwned: async () => undefined,
    cloneSidecars: async () => undefined,
    publishRuntime: async () => undefined,
  };
}

function createMissingBundleCallbacks(): ForkOperationCallbacks {
  return {
    prepareTargetBundle: async (_operation, stagingDirectory) => ({
      stagedBundlePath: join(stagingDirectory, "missing.json"),
    }),
    assertTargetAvailable: async () => undefined,
    assertRuntimeTargetOwned: async () => undefined,
    cloneSidecars: async () => undefined,
    publishRuntime: async () => undefined,
  };
}

function forkInput(
  operationId: string,
  targetSessionId: string,
  stagingDirectory: string,
): NewForkStorageOperation {
  return {
    kind: "fork",
    operationId,
    sessionId: `${operationId}-source`,
    sourceSessionId: `${operationId}-source`,
    sourceCursor: {
      logId: `${operationId}-source`,
      seq: 1,
      epoch: 0,
      eventId: `${operationId}-event`,
    },
    targetSessionId,
    targetMode: "default",
    stagingDirectory,
  };
}

function targetLeaseDirectory(journal: StorageOperationJournal, targetSessionId: string): string {
  const digest = createHash("sha256").update(targetSessionId).digest("hex");
  return join(journal.directory, ".fork-target-leases", digest);
}

function localMessage(result: Awaited<ReturnType<typeof processUserInput>>): string {
  if (result.type !== "local-command") throw new Error("expected local command result");
  return result.result.message ?? "";
}
