import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { StorageOperation } from "../../src/storage/operation-journal.js";
import { OperationReferenceIndex } from "../../src/storage/operation-reference-index.js";

test("operation reference index writes and scans only schema version 2", async (context) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pico-operation-index-v2-"));
  context.after(() => rm(baseDir, { recursive: true, force: true }));
  const journalDirectory = resolve(baseDir, "journal");
  const operation = rewindOperation("current-operation");
  const index = new OperationReferenceIndex(baseDir);

  await index.upsert(journalDirectory, operation);

  const scan = await index.scan();
  assert.deepEqual(scan.failures, []);
  assert.equal(scan.entries.length, 1);
  assert.equal(scan.entries[0]?.schemaVersion, 2);
  assert.equal(typeof scan.entries[0]?.protocolGeneration, "string");
  assert.equal(scan.entries[0]?.operationId, operation.operationId);
});

test("operation reference index rejects schema version 1 without rewriting it", async (context) => {
  const baseDir = await mkdtemp(join(tmpdir(), "pico-operation-index-v1-"));
  context.after(() => rm(baseDir, { recursive: true, force: true }));
  const journalDirectory = resolve(baseDir, "journal");
  const operation = rewindOperation("legacy-operation");
  const index = new OperationReferenceIndex(baseDir);
  const entryPath = join(
    index.directory,
    operationReferenceEntryName(journalDirectory, operation.operationId),
  );
  const legacyBytes = `${JSON.stringify(
    {
      schemaVersion: 1,
      journalDirectory,
      operationId: operation.operationId,
      operationVersion: operation.version,
      kind: operation.kind,
      state: operation.state,
      referencedDigests: [],
      updatedAt: operation.updatedAt,
    },
    null,
    2,
  )}\n`;
  await mkdir(index.directory, { recursive: true, mode: 0o700 });
  await writeFile(entryPath, legacyBytes, { mode: 0o600 });

  const scan = await index.scan();
  assert.deepEqual(scan.entries, []);
  assert.equal(scan.failures.length, 1);
  assert.match(
    scan.failures[0]?.message ?? "",
    /Unsupported operation reference index schema version 1/u,
  );

  await assert.rejects(
    index.upsert(journalDirectory, operation),
    /Unsupported operation reference index schema version 1/u,
  );
  assert.equal(await readFile(entryPath, "utf8"), legacyBytes);
  await assert.rejects(stat(join(index.directory, "gc-protocol.json")), { code: "ENOENT" });
});

function rewindOperation(operationId: string): StorageOperation {
  const updatedAt = "2026-07-28T00:00:00.000Z";
  return {
    schemaVersion: 1,
    operationId,
    version: 1,
    state: "prepared",
    sessionId: "session",
    createdAt: updatedAt,
    updatedAt,
    kind: "rewind",
    mode: "both",
    precondition: {
      sessionLastSeq: 1,
      effectiveHistoryDigest: "history",
      fileHistoryRevision: 1,
    },
    target: {
      messageId: "message",
      sourceMessageEventId: "user-message:message",
      messageIndex: 0,
      userPrompt: "canonical rewind point",
    },
    files: [],
  };
}

function operationReferenceEntryName(journalDirectory: string, operationId: string): string {
  return `${createHash("sha256")
    .update(resolve(journalDirectory))
    .update("\0")
    .update(operationId)
    .digest("hex")}.json`;
}
