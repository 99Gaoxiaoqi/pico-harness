import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  findCliSessionCatalogEntry,
  listCliSessionCatalogEntries,
  resolveCliSession,
} from "../../src/cli/session-resolver.js";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  parseRuntimeResult,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { globalSessionManager, type Session } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import type { SessionForkRuntimePort } from "../../src/engine/session-fork-runtime-port.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "../../src/runtime/session-fork-runtime-port-adapter.js";
import { fileHistoryChanges, fileHistoryTrackEdit } from "../../src/safety/file-history.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { readFileHistoryManifestRow } from "../../src/storage/sqlite/file-history-manifest-store.js";

interface RewindFixture {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly session: Session;
  readonly checkpointId: string;
  readonly firstFile: string;
  readonly secondFile: string;
  readonly expectedFingerprints: Record<string, string>;
  close(): Promise<void>;
}

async function createFixture(label: string): Promise<RewindFixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-rewind-atomic-${label}-`));
  const workDirInput = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDirInput, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const workDir = await realpath(workDirInput);
  const sessionId = `rewind-${label}-source`;
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const session = lease.session;
  await session.commitMessages({ role: "system", content: "rewind fixture seed" });
  const firstFile = join(workDir, "a.txt");
  const secondFile = join(workDir, "b.txt");
  await writeFile(firstFile, "a-before\n");
  await writeFile(secondFile, "b-before\n");
  const checkpointId = await session.beginRewindPoint({
    messageId: `checkpoint-${label}`,
    userPrompt: "change both files",
    transcriptIndex: 1,
    interactionMode: "default",
  });
  await fileHistoryTrackEdit(
    session.fileHistory,
    firstFile,
    checkpointId,
    session.id,
    session.fileHistoryIo,
  );
  await fileHistoryTrackEdit(
    session.fileHistory,
    secondFile,
    checkpointId,
    session.id,
    session.fileHistoryIo,
  );
  await session.commitMessages({ role: "user", content: "change both files" });
  await writeFile(firstFile, "a-after\n");
  await writeFile(secondFile, "b-after\n");
  const changes = await fileHistoryChanges(
    session.fileHistory,
    checkpointId,
    session.id,
    session.fileHistoryBaseDir,
  );
  const expectedFingerprints = Object.fromEntries(
    changes.files.map((file) => [file.filePath, file.currentFingerprint]),
  );

  return {
    root,
    workDir,
    picoHome,
    session,
    checkpointId,
    firstFile,
    secondFile,
    expectedFingerprints,
    async close() {
      lease.release();
      const managed = globalSessionManager.delete(session.id, workDir, { picoHome });
      await managed?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function sessionIds(fixture: RewindFixture): Promise<string[]> {
  return (await listCliSessionCatalogEntries(fixture.workDir, { picoHome: fixture.picoHome }))
    .map((entry) => entry.summary.id)
    .toSorted();
}

function rawRuntimeSessionCount(fixture: RewindFixture): number {
  const database = new DatabaseSync(
    operationalDatabasePath(fixture.session.fileHistoryIo.storageRoot),
    { readOnly: true },
  );
  try {
    return (database.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number })
      .count;
  } finally {
    database.close();
  }
}

test("rewind file transaction compensates an injected second-file failure", async () => {
  const fixture = await createFixture("partial-file");
  try {
    const checkpointRevision = fixture.session.fileHistory.revision;
    const checkpoints = fixture.session.fileHistory.snapshots.map((item) => item.messageId);
    await assert.rejects(
      fixture.session.forkFromCheckpoint(
        fixture.checkpointId,
        "code",
        createSessionForkRuntimePort(),
        () => "unused-code-target",
        fixture.expectedFingerprints,
        {
          fileTransactionHooks: {
            beforeApplyFile: (_file, index) => {
              if (index === 1) throw new Error("injected second-file restore failure");
            },
          },
        },
      ),
      /injected second-file restore failure/u,
    );
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");
    assert.deepEqual(await sessionIds(fixture), [fixture.session.id]);
    assert.equal(fixture.session.fileHistory.revision, checkpointRevision);
    assert.deepEqual(
      fixture.session.fileHistory.snapshots.map((item) => item.messageId),
      checkpoints,
    );
  } finally {
    await fixture.close();
  }
});

for (const mode of ["conversation", "both"] as const) {
  test(`rewind ${mode} compensates a definite Session commit failure`, async () => {
    const fixture = await createFixture(`commit-${mode}`);
    const actualPort = createSessionForkRuntimePort();
    const failingPort: SessionForkRuntimePort = {
      ...actualPort,
      forkSession: async () => {
        throw new Error("injected Session commit failure");
      },
    };
    try {
      const checkpointRevision = fixture.session.fileHistory.revision;
      await assert.rejects(
        fixture.session.forkFromCheckpoint(
          fixture.checkpointId,
          mode,
          failingPort,
          () => `rewind-${mode}-target`,
          fixture.expectedFingerprints,
        ),
        /injected Session commit failure/u,
      );
      assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
      assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");
      assert.deepEqual(await sessionIds(fixture), [fixture.session.id]);
      assert.equal(fixture.session.fileHistory.revision, checkpointRevision);
      assert.deepEqual(
        fixture.session.fileHistory.snapshots.map((item) => item.messageId),
        [fixture.checkpointId],
      );
    } finally {
      await fixture.close();
    }
  });
}

for (const failureKind of ["transient", "persistent"] as const) {
  test(`rewind both settles a ${failureKind} pre-publication fork failure`, async () => {
    const fixture = await createFixture(`settle-${failureKind}`);
    const targetSessionId = `rewind-settle-${failureKind}-target`;
    const basePort = createSessionForkRuntimePort();
    let failuresRemaining = failureKind === "transient" ? 1 : Number.POSITIVE_INFINITY;
    const service = new SessionForkService({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      sessionManager: globalSessionManager,
      runtimeStore: fixture.session.runtimeEventStore!,
      fileHistoryBaseDir: fixture.session.fileHistoryBaseDir,
      runtimePort: basePort,
      createOperationId: () => `rewind-settle-${failureKind}-operation`,
      hooks: {
        beforeRuntimeBootstrap: () => {
          if (failuresRemaining > 0) {
            failuresRemaining--;
            throw new Error(`injected ${failureKind} fork publication failure`);
          }
        },
      },
    });
    const settlingPort: SessionForkRuntimePort = {
      ...basePort,
      forkSession: async (input) => {
        try {
          await service.fork({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
            ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
          });
        } catch (error) {
          const settlement = await service.settleFailedFork({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.targetSessionId,
          });
          if (settlement !== "committed") throw error;
        }
      },
    };
    try {
      if (failureKind === "transient") {
        const result = await fixture.session.forkFromCheckpoint(
          fixture.checkpointId,
          "both",
          settlingPort,
          () => targetSessionId,
          fixture.expectedFingerprints,
        );
        assert.equal(result.targetSessionId, targetSessionId);
        assert.equal(await readFile(fixture.firstFile, "utf8"), "a-before\n");
        assert.equal(await readFile(fixture.secondFile, "utf8"), "b-before\n");
        assert.deepEqual(
          await sessionIds(fixture),
          [fixture.session.id, targetSessionId].toSorted(),
        );
      } else {
        const beforeCount = rawRuntimeSessionCount(fixture);
        await assert.rejects(
          fixture.session.forkFromCheckpoint(
            fixture.checkpointId,
            "both",
            settlingPort,
            () => targetSessionId,
            fixture.expectedFingerprints,
          ),
          /injected persistent fork publication failure/u,
        );
        assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
        assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");
        assert.deepEqual(await sessionIds(fixture), [fixture.session.id]);
        assert.equal(
          await findCliSessionCatalogEntry(fixture.workDir, targetSessionId, {
            picoHome: fixture.picoHome,
          }),
          undefined,
        );
        await assert.rejects(
          resolveCliSession({
            workDir: fixture.workDir,
            picoHome: fixture.picoHome,
            resumeSession: targetSessionId,
          }),
          /RuntimeEvent 日志中不存在/u,
        );
        assert.equal(
          readFileHistoryManifestRow(fixture.session.fileHistoryIo.storageRoot, targetSessionId),
          undefined,
        );
        assert.equal(
          (await service.getOperation("rewind-settle-persistent-operation"))?.state,
          "aborted",
        );
        assert.equal(rawRuntimeSessionCount(fixture), beforeCount);
        await service.reconcileUnfinished();
        assert.deepEqual(await sessionIds(fixture), [fixture.session.id]);
      }
      assert.deepEqual(
        fixture.session.fileHistory.snapshots.map((item) => item.messageId),
        [fixture.checkpointId],
      );
    } finally {
      service.close();
      await fixture.close();
    }
  });
}

test("rewind both removes an owned partial Runtime publication before returning failure", async () => {
  const fixture = await createFixture("settle-partial-publication");
  const targetSessionId = "rewind-settle-partial-publication-target";
  const actualPort = createSessionForkRuntimePort();
  let writeFenceChecks = 0;
  const faultingPort: SessionForkRuntimePort = {
    ...actualPort,
    bootstrapFork: (options) =>
      actualPort.bootstrapFork({
        ...options,
        publication: {
          assertOwned: async () => {
            await options.publication.assertOwned();
            writeFenceChecks += 1;
            if (writeFenceChecks >= 3) {
              throw new Error("injected partial Runtime publication failure");
            }
          },
        },
      }),
  };
  const service = new SessionForkService({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
    sessionManager: globalSessionManager,
    runtimeStore: fixture.session.runtimeEventStore!,
    fileHistoryBaseDir: fixture.session.fileHistoryBaseDir,
    runtimePort: faultingPort,
    createOperationId: () => "rewind-settle-partial-publication-operation",
  });
  const runtimeStore = fixture.session.runtimeEventStore!;
  const deleteSession = runtimeStore.deleteSession.bind(runtimeStore);
  let cleanupFailuresRemaining = 1;
  runtimeStore.deleteSession = async (sessionId) => {
    if (sessionId === targetSessionId && cleanupFailuresRemaining > 0) {
      cleanupFailuresRemaining -= 1;
      throw new Error("injected target cleanup failure");
    }
    return deleteSession(sessionId);
  };
  const settlingPort: SessionForkRuntimePort = {
    ...actualPort,
    forkSession: async (input) => {
      try {
        await service.fork({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
        });
      } catch (error) {
        const settlement = await service.settleFailedFork({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
        });
        if (settlement !== "committed") throw error;
      }
    },
  };
  try {
    const checkpointRevision = fixture.session.fileHistory.revision;
    const beforeIds = await sessionIds(fixture);
    const beforeCount = rawRuntimeSessionCount(fixture);
    await assert.rejects(
      fixture.session.forkFromCheckpoint(
        fixture.checkpointId,
        "both",
        settlingPort,
        () => targetSessionId,
        fixture.expectedFingerprints,
      ),
      /\u53d1\u5e03\u7ed3\u679c\u65e0\u6cd5\u5b89\u5168\u5224\u5b9a/u,
    );
    assert.ok(writeFenceChecks >= 3);
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");
    assert.deepEqual(await sessionIds(fixture), beforeIds);
    assert.equal(rawRuntimeSessionCount(fixture), beforeCount + 1);
    assert.equal(
      (await service.getOperation("rewind-settle-partial-publication-operation"))?.state,
      "needs_attention",
    );
    assert.equal(
      await findCliSessionCatalogEntry(fixture.workDir, targetSessionId, {
        picoHome: fixture.picoHome,
      }),
      undefined,
    );
    await assert.rejects(
      resolveCliSession({
        workDir: fixture.workDir,
        picoHome: fixture.picoHome,
        resumeSession: targetSessionId,
      }),
      /fork 尚未完成发布/u,
    );

    const needsAttention = await service.getOperation(
      "rewind-settle-partial-publication-operation",
    );
    assert.ok(needsAttention?.kind === "fork" && needsAttention.state === "needs_attention");
    const disposition = await service.abortNeedsAttention({
      operationId: needsAttention.operationId,
      expectedVersion: needsAttention.version,
      reason: "test deterministic rewind cleanup",
    });
    assert.equal(disposition.operation.state, "aborted");
    assert.equal(disposition.stagingCleanup, "completed");
    assert.equal(rawRuntimeSessionCount(fixture), beforeCount);
    assert.equal(await runtimeStore.readSessionManifest(targetSessionId), undefined);
    assert.equal(
      readFileHistoryManifestRow(fixture.session.fileHistoryIo.storageRoot, targetSessionId),
      undefined,
    );
    await assert.rejects(
      resolveCliSession({
        workDir: fixture.workDir,
        picoHome: fixture.picoHome,
        resumeSession: targetSessionId,
      }),
      /RuntimeEvent 日志中不存在/u,
    );
    assert.equal(fixture.session.fileHistory.revision, checkpointRevision);
    await service.reconcileUnfinished();
    assert.deepEqual(await sessionIds(fixture), beforeIds);
  } finally {
    runtimeStore.deleteSession = deleteSession;
    service.close();
    await fixture.close();
  }
});

for (const mode of ["code", "conversation", "both"] as const) {
  test(`rewind ${mode} succeeds with the declared file and Session scope`, async () => {
    const fixture = await createFixture(`success-${mode}`);
    const targetSessionId = `rewind-success-${mode}-target`;
    try {
      const checkpointRevision = fixture.session.fileHistory.revision;
      const result = await fixture.session.forkFromCheckpoint(
        fixture.checkpointId,
        mode,
        createSessionForkRuntimePort(),
        () => targetSessionId,
        fixture.expectedFingerprints,
      );
      assert.equal(result.targetSessionId, mode === "code" ? fixture.session.id : targetSessionId);
      const restoresCode = mode === "code" || mode === "both";
      assert.equal(
        await readFile(fixture.firstFile, "utf8"),
        restoresCode ? "a-before\n" : "a-after\n",
      );
      assert.equal(
        await readFile(fixture.secondFile, "utf8"),
        restoresCode ? "b-before\n" : "b-after\n",
      );
      assert.deepEqual(
        await sessionIds(fixture),
        mode === "code" ? [fixture.session.id] : [fixture.session.id, targetSessionId].toSorted(),
      );
      assert.equal(fixture.session.fileHistory.revision, checkpointRevision);
      assert.deepEqual(
        fixture.session.fileHistory.snapshots.map((item) => item.messageId),
        [fixture.checkpointId],
      );
    } finally {
      await fixture.close();
    }
  });
}

for (const variant of ["conversation", "omitted-both"] as const) {
  test(`rewind.apply ${variant} replays one durable idempotent result`, async () => {
    const fixture = await createFixture(`idempotent-${variant}`);
    const targetSessionId = `rewind-idempotent-${variant}-target`;
    const env = { PICO_HOME: fixture.picoHome };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
    await trustStore.trust(fixture.workDir);
    const runtimeService = new WorkspaceRuntimeService({
      env,
      execute: async () => undefined,
    });
    let desktop = new DesktopRuntimeService({
      runtimeService,
      trustStore,
      env,
      createSessionId: () => targetSessionId,
    });
    try {
      const preview = parseRuntimeResult(
        "rewind.preview",
        await desktop.handle(
          createRuntimeRequest("rewind.preview", {
            workspacePath: fixture.workDir,
            sessionId: fixture.session.id,
            checkpointId: fixture.checkpointId,
          }),
        ),
      );
      const baseParams = {
        workspacePath: fixture.workDir,
        sessionId: fixture.session.id,
        checkpointId: fixture.checkpointId,
        expectedFingerprint: preview.fingerprint,
        idempotencyKey: `idempotent-${variant}`,
      } as const;
      const first = parseRuntimeResult(
        "rewind.apply",
        await desktop.handle(
          createRuntimeRequest("rewind.apply", {
            ...baseParams,
            ...(variant === "conversation" ? { mode: "conversation" as const } : {}),
          }),
        ),
      );
      const replay = parseRuntimeResult(
        "rewind.apply",
        await desktop.handle(
          createRuntimeRequest("rewind.apply", {
            ...baseParams,
            ...(variant === "conversation"
              ? { mode: "conversation" as const }
              : { mode: "both" as const }),
          }),
        ),
      );
      assert.deepEqual(replay, first);
      assert.deepEqual(first, {
        applied: true,
        sessionId: targetSessionId,
        sourceSessionId: fixture.session.id,
      });
      assert.deepEqual(await sessionIds(fixture), [fixture.session.id, targetSessionId].toSorted());
      const restoresCode = variant === "omitted-both";
      assert.equal(
        await readFile(fixture.firstFile, "utf8"),
        restoresCode ? "a-before\n" : "a-after\n",
      );
      assert.equal(
        await readFile(fixture.secondFile, "utf8"),
        restoresCode ? "b-before\n" : "b-after\n",
      );

      await desktop.close();
      desktop = new DesktopRuntimeService({
        runtimeService,
        trustStore,
        env,
        createSessionId: () => {
          throw new Error("durable idempotency replay must not allocate another Session");
        },
      });
      const replayAfterRestart = parseRuntimeResult(
        "rewind.apply",
        await desktop.handle(
          createRuntimeRequest("rewind.apply", {
            ...baseParams,
            ...(variant === "conversation"
              ? { mode: "conversation" as const }
              : { mode: "both" as const }),
          }),
        ),
      );
      assert.deepEqual(replayAfterRestart, first);

      await assert.rejects(
        desktop.handle(
          createRuntimeRequest("rewind.apply", {
            ...baseParams,
            mode: variant === "conversation" ? "both" : "conversation",
          }),
        ),
        (error: unknown) =>
          error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
      );
      assert.deepEqual(await sessionIds(fixture), [fixture.session.id, targetSessionId].toSorted());
    } finally {
      await desktop.close();
      const target = globalSessionManager.delete(targetSessionId, fixture.workDir, {
        picoHome: fixture.picoHome,
      });
      await target?.close();
      await fixture.close();
    }
  });
}
