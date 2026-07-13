import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionIdentity } from "../src/engine/session-identity.js";
import { readVersionedJson, writeJsonAtomic } from "../src/storage/atomic-json.js";
import { LeaseConflictError, OwnerLease } from "../src/storage/owner-lease.js";
import { StorageOperationJournal } from "../src/storage/operation-journal.js";
import { SessionCatalog, type SessionCatalogEntry } from "../src/storage/session-catalog.js";

describe("storage foundation integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("atomically persists sidecars, arbitrates the writer lease and tolerates a bad catalog entry", async () => {
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

    const workDir = join(root, "workspace");
    const catalog = new SessionCatalog({ baseDirectory: join(root, "catalog") });
    const entry = {
      schemaVersion: 1,
      logId: "log-a",
      sessionId: "session-a",
      logPath: join(workDir, ".claw", "sessions", "session-a.jsonl"),
      identity: createSessionIdentity({ sessionId: "session-a", cwd: workDir }),
      lineage: { relation: "root", rootLogId: "log-a" },
      title: "Storage evolution",
      messageCount: 2,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:01.000Z",
      lastOpenedAt: "2026-07-13T00:00:01.000Z",
      journalSchemaVersion: 3,
      head: { logId: "log-a", epoch: 0, seq: 1, eventId: "event-1" },
      health: "healthy",
    } satisfies SessionCatalogEntry;
    await catalog.upsert(entry);
    await writeFile(join(catalog.entriesDirectory, "broken.json"), "{not json", "utf8");

    await expect(catalog.list({ sessionProjectDir: workDir })).resolves.toEqual([entry]);
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
