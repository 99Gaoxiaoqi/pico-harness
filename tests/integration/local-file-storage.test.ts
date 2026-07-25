import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commitFileTransactionSync,
  FileStorageIntegrityError,
  readJsonLinesSync,
  recoverFileTransactionSync,
  withFileLockSync,
} from "../../src/storage/local-file-storage.js";

test("file transaction recovers a published replacement and append exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "state.json"), '{"revision":1}\n', { mode: 0o600 });
  await writeFile(join(root, "events.jsonl"), '{"eventId":"one"}\n', { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          {
            replacements: [
              { relativePath: "state.json", content: '{"revision":2,"lastTransactionId":"tx"}\n' },
            ],
            appends: [{ relativePath: "events.jsonl", content: '{"eventId":"two"}\n' }],
          },
          {
            transactionId: "tx",
            onStage(stage) {
              if (stage === "commit-published") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/,
  );

  withFileLockSync(join(root, "lock"), "recovery", () => {
    assert.equal(recoverFileTransactionSync(root), "tx");
    assert.equal(recoverFileTransactionSync(root), undefined);
  });

  assert.equal(await readFile(join(root, "state.json"), "utf8"), '{"revision":2,"lastTransactionId":"tx"}\n');
  assert.equal(
    await readFile(join(root, "events.jsonl"), "utf8"),
    '{"eventId":"one"}\n{"eventId":"two"}\n',
  );
});

test("file transaction repairs an interrupted append from its durable commit marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-partial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "events.jsonl");
  await writeFile(ledgerPath, '{"eventId":"one"}\n', { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          { appends: [{ relativePath: "events.jsonl", content: '{"eventId":"two"}\n' }] },
          {
            transactionId: "partial-tx",
            onStage(stage) {
              if (stage === "commit-published") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/,
  );
  await writeFile(ledgerPath, '{"eventId":"one"}\n{"event', { mode: 0o600 });

  withFileLockSync(join(root, "lock"), "recovery", () => {
    recoverFileTransactionSync(root);
  });
  assert.deepEqual(readJsonLinesSync(ledgerPath), [{ eventId: "one" }, { eventId: "two" }]);
});

test("JSONL repairs only an incomplete tail and rejects malformed complete records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-jsonl-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "events.jsonl");

  await writeFile(ledgerPath, '{"eventId":"one"}\n{"eventId":', { mode: 0o600 });
  assert.deepEqual(readJsonLinesSync(ledgerPath, true), [{ eventId: "one" }]);

  await writeFile(ledgerPath, '{"eventId":"one"}\nnot-json\n', { mode: 0o600 });
  assert.throws(() => readJsonLinesSync(ledgerPath, true), FileStorageIntegrityError);
});
