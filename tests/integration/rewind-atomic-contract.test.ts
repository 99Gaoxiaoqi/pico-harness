import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { JsonObject } from "@pico/protocol";
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
import {
  fileHistoryApplyDurableRewindPlan,
  fileHistoryChanges,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";
import { projectDesktopCheckpoint } from "../../src/daemon/desktop-review.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { operationalDatabasePath } from "../../src/storage/sqlite/sqlite-database.js";
import { readFileHistoryManifestRow } from "../../src/storage/sqlite/file-history-manifest-store.js";
import { SqliteDesktopConversationStateStore } from "../../src/storage/sqlite/sqlite-desktop-conversation-state-store.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { retireOwnerLeaseForTerminatedProcess } from "../../src/storage/owner-lease.js";
import { sessionOwnerLeaseDirectory } from "../../src/storage/session-owner-lease.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

interface RewindFixture {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly session: Session;
  readonly checkpointId: string;
  readonly firstFile: string;
  readonly secondFile: string;
  readonly expectedFingerprints: Record<string, string>;
  releaseSession(): Promise<void>;
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

  let released = false;
  const releaseSession = async () => {
    if (released) return;
    released = true;
    lease.release();
    const managed = globalSessionManager.delete(session.id, workDir, { picoHome });
    await managed?.close();
  };
  return {
    root,
    workDir,
    picoHome,
    session,
    checkpointId,
    firstFile,
    secondFile,
    expectedFingerprints,
    releaseSession,
    async close() {
      await releaseSession();
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

class OneShotFailingRewindReceiptStore extends SqliteDesktopConversationStateStore {
  private failed = false;

  override async rememberIdempotent(
    workspacePath: string,
    key: string,
    requestFingerprint: string,
    result: JsonObject,
  ): Promise<void> {
    if (!this.failed && key.startsWith("rewind.apply:")) {
      this.failed = true;
      throw new Error("injected rewind receipt persistence crash");
    }
    return super.rememberIdempotent(workspacePath, key, requestFingerprint, result);
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
            ...(input.rewind ? { rewind: input.rewind } : {}),
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

for (const cut of ["prepared-journal", "first-file", "last-file", "sidecars"] as const) {
  test(`rewind both recovers after a ${cut} process cut`, async () => {
    const fixture = await createFixture(`crash-${cut}`);
    const operationId = `rewind-crash-${cut}-operation`;
    const targetSessionId = `rewind-crash-${cut}-target`;
    const basePort = createSessionForkRuntimePort();
    const firstService = new SessionForkService({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      runtimePort: basePort,
      hooks: {
        ...(cut === "prepared-journal"
          ? { beforeWorkspaceApply: () => Promise.reject(new Error(`cut:${cut}`)) }
          : {}),
        ...(cut === "sidecars"
          ? { afterSidecars: () => Promise.reject(new Error(`cut:${cut}`)) }
          : {}),
      },
    });
    const crashPort: SessionForkRuntimePort = {
      ...basePort,
      forkSession: async (input) => {
        await firstService.fork({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          ...(input.operationId ? { operationId: input.operationId } : {}),
          ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
          ...(input.fallbackSettings ? { fallbackSettings: input.fallbackSettings } : {}),
          ...(input.rewind ? { rewind: input.rewind } : {}),
        });
      },
    };
    try {
      await assert.rejects(
        fixture.session.forkFromCheckpoint(
          fixture.checkpointId,
          "both",
          crashPort,
          () => targetSessionId,
          fixture.expectedFingerprints,
          {
            operationId,
            ...(cut === "first-file" || cut === "last-file"
              ? {
                  fileTransactionHooks: {
                    afterApplyFile: (_file, index) => {
                      if (index === (cut === "first-file" ? 0 : 1)) {
                        throw new Error(`cut:${cut}`);
                      }
                    },
                  },
                }
              : {}),
          },
        ),
        new RegExp(`cut:${cut}`, "u"),
      );
      firstService.close();

      const reopenedStore = new SqliteRuntimeEventStore({
        storageRoot: fixture.session.fileHistoryIo.storageRoot,
      });
      const reopened = new SessionForkService({
        workDir: fixture.workDir,
        picoHome: fixture.picoHome,
        runtimeStore: reopenedStore,
        runtimePort: basePort,
      });
      try {
        const recovered = await reopened.reconcileUnfinished();
        assert.deepEqual(recovered, [{ operationId, state: "completed" }]);
        assert.equal((await reopened.getOperation(operationId))?.state, "completed");
      } finally {
        reopened.close();
        reopenedStore.close();
      }
      assert.equal(await readFile(fixture.firstFile, "utf8"), "a-before\n");
      assert.equal(await readFile(fixture.secondFile, "utf8"), "b-before\n");
      assert.deepEqual(await sessionIds(fixture), [fixture.session.id, targetSessionId].toSorted());
    } finally {
      firstService.close();
      await fixture.close();
    }
  });
}

test("rewind both safely replays a frozen bundle cut before journal creation", async () => {
  const fixture = await createFixture("crash-frozen-bundle");
  const operationId = "rewind-crash-frozen-bundle-operation";
  const targetSessionId = "rewind-crash-frozen-bundle-target";
  const basePort = createSessionForkRuntimePort();
  const firstService = new SessionForkService({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
    runtimePort: basePort,
    hooks: { afterFrozenBundle: () => Promise.reject(new Error("cut:frozen-bundle")) },
  });
  const crashPort: SessionForkRuntimePort = {
    ...basePort,
    forkSession: async (input) => {
      await firstService.fork({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
        ...(input.fallbackSettings ? { fallbackSettings: input.fallbackSettings } : {}),
        ...(input.rewind ? { rewind: input.rewind } : {}),
      });
    },
  };
  try {
    await assert.rejects(
      fixture.session.forkFromCheckpoint(
        fixture.checkpointId,
        "both",
        crashPort,
        () => targetSessionId,
        fixture.expectedFingerprints,
        { operationId },
      ),
      /cut:frozen-bundle/u,
    );
    assert.equal(await firstService.getOperation(operationId), undefined);
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");
    const orphanStaging = join(
      resolvePicoPaths(fixture.workDir, { picoHome: fixture.picoHome }).workspace.forkStaging,
      operationId,
    );
    const orphanBundlePath = join(orphanStaging, "runtime-fork.json");
    const orphanBundle = await readFile(orphanBundlePath);
    const orphanManifest = JSON.parse(
      await readFile(join(orphanStaging, "fork-bundle.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(orphanManifest["stagedBundlePath"], orphanBundlePath);
    assert.equal(orphanManifest["sizeBytes"], orphanBundle.byteLength);
    assert.equal(
      orphanManifest["contentSha256"],
      createHash("sha256").update(orphanBundle).digest("hex"),
    );
    firstService.close();

    const replay = await fixture.session.forkFromCheckpoint(
      fixture.checkpointId,
      "both",
      basePort,
      () => targetSessionId,
      fixture.expectedFingerprints,
      { operationId },
    );
    assert.equal(replay.targetSessionId, targetSessionId);
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-before\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-before\n");
    assert.deepEqual(await sessionIds(fixture), [fixture.session.id, targetSessionId].toSorted());
  } finally {
    firstService.close();
    await fixture.close();
  }
});

test("durable workspace conflict retains the fixed Rewind target claim", async () => {
  const fixture = await createFixture("workspace-conflict-claim");
  const operationId = "rewind-workspace-conflict-operation";
  const targetSessionId = "rewind-workspace-conflict-target";
  const contenderOperationId = "rewind-workspace-conflict-contender";
  const basePort = createSessionForkRuntimePort();
  const firstService = new SessionForkService({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
    runtimePort: basePort,
    hooks: {
      beforeWorkspaceApply: () => Promise.reject(new Error("cut:before-workspace-conflict")),
    },
  });
  const crashPort: SessionForkRuntimePort = {
    ...basePort,
    forkSession: async (input) => {
      await firstService.fork({
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
        ...(input.rewind ? { rewind: input.rewind } : {}),
      });
    },
  };
  try {
    await assert.rejects(
      fixture.session.forkFromCheckpoint(
        fixture.checkpointId,
        "both",
        crashPort,
        () => targetSessionId,
        fixture.expectedFingerprints,
        { operationId },
      ),
      /cut:before-workspace-conflict/u,
    );
    firstService.close();
    await writeFile(fixture.firstFile, "external-change\n");

    const reopened = new SessionForkService({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      runtimePort: basePort,
    });
    try {
      assert.deepEqual(await reopened.reconcileUnfinished(), [
        { operationId, state: "needs_attention" },
      ]);
      const conflicted = await reopened.getOperation(operationId);
      assert.ok(conflicted?.kind === "fork" && conflicted.state === "needs_attention");
      assert.match(conflicted.error?.message ?? "", /^workspace_conflict:/u);

      await assert.rejects(
        reopened.fork({
          sourceSessionId: fixture.session.id,
          targetSessionId,
          operationId: contenderOperationId,
        }),
        /requires manual attention|需要人工处理/u,
      );
      const contender = await reopened.getOperation(contenderOperationId);
      assert.ok(contender?.kind === "fork" && contender.state === "needs_attention");
      assert.match(contender.error?.message ?? "", /^target_conflict:/u);
      assert.equal((await reopened.getOperation(operationId))?.state, "needs_attention");
      assert.deepEqual(await sessionIds(fixture), [fixture.session.id]);
    } finally {
      reopened.close();
    }
  } finally {
    firstService.close();
    await fixture.close();
  }
});

for (const tamper of ["bundle-root", "manifest-path", "missing-manifest-bundle-root"] as const) {
  test(`durable Rewind ${tamper} tampering cannot escape staging or release the target claim`, async () => {
    const fixture = await createFixture(`staging-tamper-${tamper}`);
    const operationId = `rewind-staging-tamper-${tamper}-operation`;
    const targetSessionId = `rewind-staging-tamper-${tamper}-target`;
    const outsideFile = join(fixture.root, `outside-${tamper}.txt`);
    await writeFile(outsideFile, "outside-safe\n");
    const basePort = createSessionForkRuntimePort();
    const firstService = new SessionForkService({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      runtimePort: basePort,
      hooks: {
        beforeWorkspaceApply: () => Promise.reject(new Error(`cut:${tamper}`)),
      },
    });
    const crashPort: SessionForkRuntimePort = {
      ...basePort,
      forkSession: async (input) => {
        await firstService.fork({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          ...(input.operationId ? { operationId: input.operationId } : {}),
          ...(input.throughEventId ? { throughEventId: input.throughEventId } : {}),
          ...(input.fallbackSettings ? { fallbackSettings: input.fallbackSettings } : {}),
          ...(input.rewind ? { rewind: input.rewind } : {}),
        });
      },
    };
    try {
      await assert.rejects(
        fixture.session.forkFromCheckpoint(
          fixture.checkpointId,
          "both",
          crashPort,
          () => targetSessionId,
          fixture.expectedFingerprints,
          { operationId },
        ),
        new RegExp(`cut:${tamper}`, "u"),
      );
      const prepared = await firstService.getOperation(operationId);
      assert.ok(prepared?.kind === "fork" && prepared.state === "prepared");
      const bundlePath = join(prepared.stagingDirectory, "runtime-fork.json");
      const manifestPath = join(prepared.stagingDirectory, "fork-bundle.json");
      if (tamper === "bundle-root" || tamper === "missing-manifest-bundle-root") {
        const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
          rewind: { roots: Array<{ absolutePath: string }> };
        };
        bundle.rewind.roots[0]!.absolutePath = fixture.root;
        await writeFile(bundlePath, `${JSON.stringify(bundle)}\n`);
        if (tamper === "missing-manifest-bundle-root") await rm(manifestPath);
      } else {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
        manifest["stagedBundlePath"] = outsideFile;
        await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      }
      firstService.close();

      const reopened = new SessionForkService({
        workDir: fixture.workDir,
        picoHome: fixture.picoHome,
        runtimePort: createSessionForkRuntimePort(),
      });
      try {
        assert.deepEqual(await reopened.reconcileUnfinished(), [
          { operationId, state: "needs_attention" },
        ]);
        const conflicted = await reopened.getOperation(operationId);
        assert.ok(conflicted?.kind === "fork" && conflicted.state === "needs_attention");
        assert.match(
          conflicted.error?.message ?? "",
          tamper === "manifest-path" ? /^invalid_operation:/u : /^staging_corrupt:/u,
        );
        assert.equal(await readFile(outsideFile, "utf8"), "outside-safe\n");
        assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
        assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");

        if (tamper === "missing-manifest-bundle-root") {
          await assert.rejects(
            reopened.abortNeedsAttention({
              operationId,
              expectedVersion: conflicted.version,
              reason: "corrupt staging cannot authorize cleanup",
            }),
            /bundle manifest is missing/u,
          );
          assert.equal((await reopened.getOperation(operationId))?.state, "needs_attention");
        }

        await assert.rejects(
          reopened.fork({
            sourceSessionId: fixture.session.id,
            targetSessionId,
            operationId: `${operationId}-contender`,
          }),
          /requires manual attention|需要人工处理/u,
        );
        const contender = await reopened.getOperation(`${operationId}-contender`);
        assert.ok(contender?.kind === "fork" && contender.state === "needs_attention");
        assert.match(contender.error?.message ?? "", /^target_conflict:/u);
      } finally {
        reopened.close();
      }
    } finally {
      firstService.close();
      await fixture.close();
    }
  });
}

test("durable Rewind rejects a retargeted workspace root before writing through it", async () => {
  const fixture = await createFixture("root-retarget");
  const originalWorkspace = join(fixture.root, "workspace-original");
  const foreignWorkspace = join(fixture.root, "workspace-foreign");
  let rootRetargeted = false;
  try {
    const plan = await fixture.session.prepareDurableRewindPlan(
      fixture.checkpointId,
      new Map(Object.entries(fixture.expectedFingerprints)),
    );
    await mkdir(foreignWorkspace, { recursive: true });
    await writeFile(join(foreignWorkspace, "a.txt"), "foreign-a\n");
    await writeFile(join(foreignWorkspace, "b.txt"), "foreign-b\n");
    await rename(fixture.workDir, originalWorkspace);
    await symlink(foreignWorkspace, fixture.workDir, "dir");
    rootRetargeted = true;

    await assert.rejects(
      fileHistoryApplyDurableRewindPlan(plan),
      /durable rewind state conflicts/u,
    );
    assert.equal(await readFile(join(foreignWorkspace, "a.txt"), "utf8"), "foreign-a\n");
    assert.equal(await readFile(join(foreignWorkspace, "b.txt"), "utf8"), "foreign-b\n");
  } finally {
    if (rootRetargeted) {
      await unlink(fixture.workDir);
      await rename(originalWorkspace, fixture.workDir);
    }
    await fixture.close();
  }
});

test("rewind.apply replays the fixed operation after a real last-file SIGKILL", async () => {
  const fixture = await createFixture("sigkill-last-file");
  const targetSessionId = "rewind-sigkill-last-file-target";
  const rawIdempotencyKey = "sigkill-last-file";
  const idempotencyKey = `rewind.apply:${rawIdempotencyKey}`;
  const operationId = `rewind-${createHash("sha256")
    .update(`${fixture.workDir}\0${idempotencyKey}`)
    .digest("hex")}`;
  const preview = await projectDesktopCheckpoint(fixture.session, fixture.checkpointId);
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        workspacePath: fixture.workDir,
        sessionId: fixture.session.id,
        checkpointId: fixture.checkpointId,
        expectedFingerprint: preview.fingerprint,
        mode: "both",
      }),
    )
    .digest("hex");
  const claimStore = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
  await claimStore.claimRewind(
    fixture.workDir,
    idempotencyKey,
    fixture.session.id,
    targetSessionId,
    operationId,
    requestFingerprint,
  );
  await fixture.releaseSession();

  const encoded = Buffer.from(
    JSON.stringify({
      workDir: fixture.workDir,
      picoHome: fixture.picoHome,
      sessionId: fixture.session.id,
      checkpointId: fixture.checkpointId,
      targetSessionId,
      operationId,
    }),
  ).toString("base64url");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "tests/fixtures/rewind-sigkill-child.ts"), encoded],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  const childPid = child.pid;
  assert.ok(childPid);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  assert.deepEqual(outcome, { code: null, signal: "SIGKILL" });
  const workspacePaths = resolvePicoPaths(fixture.workDir, {
    picoHome: fixture.picoHome,
  }).workspace;
  for (const sessionId of [fixture.session.id, targetSessionId]) {
    await retireOwnerLeaseForTerminatedProcess({
      leaseDirectory: sessionOwnerLeaseDirectory(workspacePaths, sessionId),
      expectedPid: childPid,
    });
  }
  assert.equal(await readFile(fixture.firstFile, "utf8"), "a-before\n");
  assert.equal(await readFile(fixture.secondFile, "utf8"), "b-before\n");

  const env = { PICO_HOME: fixture.picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(fixture.workDir);
  const runtimeService = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService,
    trustStore,
    env,
    createSessionId: () => {
      throw new Error("replay must retain the durable target claim");
    },
  });
  try {
    const replay = parseRuntimeResult(
      "rewind.apply",
      await desktop.handle(
        createRuntimeRequest("rewind.apply", {
          workspacePath: fixture.workDir,
          sessionId: fixture.session.id,
          checkpointId: fixture.checkpointId,
          expectedFingerprint: preview.fingerprint,
          mode: "both",
          idempotencyKey: rawIdempotencyKey,
        }),
      ),
    );
    assert.equal(replay.sessionId, targetSessionId);
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-before\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-before\n");
    assert.deepEqual(await sessionIds(fixture), [fixture.session.id, targetSessionId].toSorted());
  } finally {
    await desktop.close();
    await runtimeService.close();
    await fixture.close();
  }
});

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
          ...(input.rewind ? { rewind: input.rewind } : {}),
        });
      } catch (error) {
        const settlement = await service.settleFailedFork({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          cleanupOnly: true,
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
    assert.equal(needsAttention.recoveryPolicy, "cleanup_only");
    const disposition = await service.retryNeedsAttention({
      operationId: needsAttention.operationId,
      expectedVersion: needsAttention.version,
      reason: "retry must remain deterministic cleanup-only",
    });
    assert.equal(disposition.operation.state, "aborted");
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
    const afterReconcile = await service.getOperation(needsAttention.operationId);
    assert.equal(afterReconcile?.state, "aborted");
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

test("rewind receipt crash resumes the durable claim without allocating a second target", async () => {
  const fixture = await createFixture("receipt-crash");
  const env = { PICO_HOME: fixture.picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(fixture.workDir);
  let runtimeService = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  let allocations = 0;
  let desktop = new DesktopRuntimeService({
    runtimeService,
    trustStore,
    env,
    conversationStateStore: new OneShotFailingRewindReceiptStore({ picoHome: fixture.picoHome }),
    createSessionId: () => `rewind-receipt-target-${++allocations}`,
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
    const params = {
      workspacePath: fixture.workDir,
      sessionId: fixture.session.id,
      checkpointId: fixture.checkpointId,
      expectedFingerprint: preview.fingerprint,
      mode: "conversation" as const,
      idempotencyKey: "receipt-crash-fixed",
    };
    const first = parseRuntimeResult(
      "rewind.apply",
      await desktop.handle(createRuntimeRequest("rewind.apply", params)),
    );
    assert.equal(allocations, 1);
    await desktop.close();

    runtimeService = new WorkspaceRuntimeService({ env, execute: async () => undefined });
    desktop = new DesktopRuntimeService({
      runtimeService,
      trustStore,
      env,
      createSessionId: () => {
        throw new Error("restart must reuse the durable rewind target claim");
      },
    });
    const replay = parseRuntimeResult(
      "rewind.apply",
      await desktop.handle(createRuntimeRequest("rewind.apply", params)),
    );
    assert.deepEqual(replay, first);
    assert.deepEqual(await sessionIds(fixture), [fixture.session.id, first.sessionId].toSorted());
  } finally {
    await desktop.close();
    await fixture.close();
  }
});

test("conversation rewind ignores incomplete FileHistory while code and both fail closed", async () => {
  const fixture = await createFixture("conversation-incomplete");
  const env = { PICO_HOME: fixture.picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(fixture.workDir);
  const runtimeService = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  let targetSequence = 0;
  const desktop = new DesktopRuntimeService({
    runtimeService,
    trustStore,
    env,
    createSessionId: () => `rewind-incomplete-target-${++targetSequence}`,
  });
  try {
    fixture.session.fileHistory.snapshots[0]!.journalWarnings = ["injected incomplete history"];
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
    const base = {
      workspacePath: fixture.workDir,
      sessionId: fixture.session.id,
      checkpointId: fixture.checkpointId,
      expectedFingerprint: preview.fingerprint,
    };
    const conversation = parseRuntimeResult(
      "rewind.apply",
      await desktop.handle(
        createRuntimeRequest("rewind.apply", {
          ...base,
          mode: "conversation",
          idempotencyKey: "incomplete-conversation",
        }),
      ),
    );
    assert.equal(conversation.applied, true);
    assert.equal(await readFile(fixture.firstFile, "utf8"), "a-after\n");
    assert.equal(await readFile(fixture.secondFile, "utf8"), "b-after\n");

    for (const mode of ["code", "both"] as const) {
      await assert.rejects(
        desktop.handle(
          createRuntimeRequest("rewind.apply", {
            ...base,
            mode,
            idempotencyKey: `incomplete-${mode}`,
          }),
        ),
        /Rewind 捕获不完整/u,
      );
    }
  } finally {
    await desktop.close();
    await fixture.close();
  }
});

test("legacy missing settings rewind freezes durable agent/default on the target", async () => {
  const fixture = await createFixture("legacy-safe-settings");
  const targetSessionId = "rewind-legacy-safe-settings-target";
  const env = { PICO_HOME: fixture.picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await trustStore.trust(fixture.workDir);
  const runtimeService = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService,
    trustStore,
    env,
    createSessionId: () => targetSessionId,
  });
  try {
    assert.equal(fixture.session.getRuntimeStateSnapshot().settings, undefined);
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
    await desktop.handle(
      createRuntimeRequest("rewind.apply", {
        workspacePath: fixture.workDir,
        sessionId: fixture.session.id,
        checkpointId: fixture.checkpointId,
        expectedFingerprint: preview.fingerprint,
        mode: "conversation",
        idempotencyKey: "legacy-safe-settings",
      }),
    );
    const targetLease = await globalSessionManager.getOrCreatePinned(
      targetSessionId,
      fixture.workDir,
      {
        persistence: true,
        picoHome: fixture.picoHome,
        runtimePort: createEngineRuntimePort(),
      },
    );
    try {
      const settings = targetLease.session.getRuntimeStateSnapshot().settings;
      assert.equal(settings?.collaborationMode, "agent");
      assert.equal(settings?.permissionMode, "default");
      assert.deepEqual(settings?.additionalDirectories, []);
    } finally {
      targetLease.release();
    }
  } finally {
    await desktop.close();
    await fixture.close();
  }
});
