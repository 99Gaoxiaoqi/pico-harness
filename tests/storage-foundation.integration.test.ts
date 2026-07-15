import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVersionedJson, writeJsonAtomic } from "../src/storage/atomic-json.js";
import { LeaseConflictError, OwnerLease } from "../src/storage/owner-lease.js";
import { StorageOperationJournal } from "../src/storage/operation-journal.js";

describe("storage foundation integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("atomically persists sidecars and arbitrates the writer lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-storage-foundation-"));
    cleanup.push(root);

    const statePath = join(root, "state", "value.json");
    await writeJsonAtomic(statePath, { version: 1, value: "durable" });
    await expect(
      readVersionedJson(statePath, (value) => {
        if (!isRecord(value) || value["version"] !== 1 || typeof value["value"] !== "string") {
          throw new Error("invalid test state");
        }
        return value["value"];
      }),
    ).resolves.toBe("durable");
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);

    const leaseDirectory = join(root, "leases", "session-a");
    const first = await OwnerLease.acquire({ leaseDirectory, ownerId: "first" });
    await expect(OwnerLease.acquire({ leaseDirectory, ownerId: "second" })).rejects.toBeInstanceOf(
      LeaseConflictError,
    );
    await first.release();
    const second = await OwnerLease.acquire({ leaseDirectory, ownerId: "second" });
    await second.assertOwnership();
    await second.release();

    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({
      version: 1,
      value: "durable",
    });
  });

  it("persists a rewind saga and rejects stale or backward transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-operation-journal-"));
    cleanup.push(root);
    const journal = new StorageOperationJournal({ workDir: root });
    journal.attachReferenceIndex(join(root, "file-history"));
    const prepared = await journal.create({
      operationId: "rewind-1",
      kind: "rewind",
      sessionId: "session-a",
      mode: "both",
      precondition: {
        sessionLastSeq: 4,
        effectiveHistoryDigest: "history-digest",
        fileHistoryRevision: 2,
      },
      target: { messageId: "message-a", sourceMessageEventId: "event-a", messageIndex: 1 },
      files: [
        {
          rootId: "root",
          relativePath: "src/a.ts",
          before: { kind: "file", blobSha256: "a".repeat(64), sizeBytes: 4, mode: 0o644 },
          after: { kind: "file", blobSha256: "b".repeat(64), sizeBytes: 5, mode: 0o644 },
        },
      ],
    });
    const workspaceApplied = await journal.advance({
      operationId: prepared.operationId,
      expectedVersion: prepared.version,
      nextState: "workspace_applied",
    });
    await expect(
      journal.advance({
        operationId: prepared.operationId,
        expectedVersion: prepared.version,
        nextState: "completed",
      }),
    ).rejects.toThrow("version conflict");
    await expect(
      journal.advance({
        operationId: prepared.operationId,
        expectedVersion: workspaceApplied.version,
        nextState: "prepared",
      }),
    ).rejects.toThrow("Invalid storage operation transition");
    await expect(journal.listUnfinished()).resolves.toEqual([workspaceApplied]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
