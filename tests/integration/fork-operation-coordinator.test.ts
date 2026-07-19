import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ForkOperationCoordinator,
  ForkOperationLeaseTimeoutError,
  type ForkRuntimePublicationCapability,
} from "../../src/storage/fork-operation-coordinator.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { sessionOwnerLeaseDirectory } from "../../src/storage/session-owner-lease.js";
import { OwnerLease } from "../../src/storage/owner-lease.js";

test("fork coordinator scopes Runtime publication to the active target lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-fork-publication-capability-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const journal = new StorageOperationJournal({ workDir, picoHome });
  let captured: ForkRuntimePublicationCapability | undefined;
  try {
    const coordinator = new ForkOperationCoordinator({
      journal,
      targetLeaseDirectory: (sessionId) =>
        sessionOwnerLeaseDirectory(resolvePicoPaths(workDir, { picoHome }).workspace, sessionId),
      callbacks: {
        async prepareTargetBundle(_operation, stagingDirectory) {
          const stagedBundlePath = join(stagingDirectory, "payload.json");
          await writeFile(stagedBundlePath, '{"ok":true}\n', { mode: 0o600 });
          return { stagedBundlePath };
        },
        async assertTargetAvailable() {},
        async assertRuntimeTargetOwned() {},
        async cloneSidecars() {},
        async publishRuntime(_operation, _bundle, publication) {
          captured = publication;
          await publication.assertOwned();
        },
      },
    });

    const operation = await coordinator.execute({
      kind: "fork",
      operationId: "fork-publication-capability",
      sessionId: "source",
      sourceSessionId: "source",
      sourceCursor: { logId: "log", seq: 1, epoch: 0, eventId: "source-event" },
      targetSessionId: "target",
      targetMode: "default",
      stagingDirectory: join(root, "staging", "fork-publication-capability"),
    });

    assert.equal(operation.state, "completed");
    assert.ok(captured);
    await assert.rejects(captured.assertOwned(), /publication capability expired/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fork target publication competes with the normal Session owner lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-fork-shared-session-lease-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const workspace = resolvePicoPaths(workDir, { picoHome }).workspace;
  const targetLeaseDirectory = (sessionId: string) =>
    sessionOwnerLeaseDirectory(workspace, sessionId);
  const owner = await OwnerLease.acquire({
    leaseDirectory: targetLeaseDirectory("target"),
    ownerId: "runtime-session:target",
  });
  let sidecarWrites = 0;
  try {
    const coordinator = new ForkOperationCoordinator({
      journal: new StorageOperationJournal({ workDir, picoHome }),
      targetLeaseDirectory,
      leaseAcquisitionTimeoutMs: 0,
      callbacks: {
        async prepareTargetBundle(_operation, stagingDirectory) {
          const stagedBundlePath = join(stagingDirectory, "payload.json");
          await writeFile(stagedBundlePath, '{"ok":true}\n', { mode: 0o600 });
          return { stagedBundlePath };
        },
        async assertTargetAvailable() {},
        async assertRuntimeTargetOwned() {},
        async cloneSidecars() {
          sidecarWrites++;
        },
        async publishRuntime() {},
      },
    });

    await assert.rejects(
      coordinator.execute({
        kind: "fork",
        operationId: "fork-shared-owner-lease",
        sessionId: "source",
        sourceSessionId: "source",
        sourceCursor: { logId: "log", seq: 1, epoch: 0, eventId: "source-event" },
        targetSessionId: "target",
        targetMode: "default",
        stagingDirectory: join(root, "staging", "fork-shared-owner-lease"),
      }),
      ForkOperationLeaseTimeoutError,
    );
    assert.equal(sidecarWrites, 0);
  } finally {
    await owner.release();
    await rm(root, { recursive: true, force: true });
  }
});
