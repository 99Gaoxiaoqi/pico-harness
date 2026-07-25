import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  commitFileTransactionSync,
  FileLockTimeoutError,
  FileStorageIntegrityError,
  inspectFileTransactionMarkerSync,
  readJsonLinesSync,
  recoverFileTransactionSync,
  withFileLock,
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

  assert.equal(
    await readFile(join(root, "state.json"), "utf8"),
    '{"revision":2,"lastTransactionId":"tx"}\n',
  );
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
  assert.equal(inspectFileTransactionMarkerSync(root).status, "pending");
  await writeFile(ledgerPath, '{"eventId":"one"}\n{"event', { mode: 0o600 });
  assert.equal(inspectFileTransactionMarkerSync(root).status, "partially-applied");

  withFileLockSync(join(root, "lock"), "recovery", () => {
    recoverFileTransactionSync(root);
  });
  assert.deepEqual(readJsonLinesSync(ledgerPath), [{ eventId: "one" }, { eventId: "two" }]);
});

test("file transaction recovery is idempotent after every target was already applied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-applied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "state.json"), '{"revision":1}\n', { mode: 0o600 });
  await writeFile(join(root, "events.jsonl"), "", { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          {
            replacements: [{ relativePath: "state.json", content: '{"revision":2}\n' }],
            appends: [{ relativePath: "events.jsonl", content: '{"eventId":"one"}\n' }],
          },
          {
            transactionId: "applied-tx",
            onStage(stage) {
              if (stage === "targets-applied") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/u,
  );
  withFileLockSync(join(root, "lock"), "recovery", () => {
    assert.equal(recoverFileTransactionSync(root), "applied-tx");
  });
  assert.equal(await readFile(join(root, "state.json"), "utf8"), '{"revision":2}\n');
  assert.equal(await readFile(join(root, "events.jsonl"), "utf8"), '{"eventId":"one"}\n');
});

test("a malformed commit marker is fully validated before any target is applied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-invalid-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.json"), '{"revision":1}\n', { mode: 0o600 });
  await writeFile(join(root, "second.json"), '{"revision":1}\n', { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          {
            replacements: [
              { relativePath: "first.json", content: '{"revision":2}\n' },
              { relativePath: "second.json", content: '{"revision":2}\n' },
            ],
          },
          {
            onStage(stage) {
              if (stage === "commit-published") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/u,
  );
  const commitPath = join(root, "commit.json");
  const commit = JSON.parse(await readFile(commitPath, "utf8")) as {
    replacements: Array<{ contentBase64: string }>;
  };
  commit.replacements[1]!.contentBase64 = "not canonical base64";
  await writeFile(commitPath, `${JSON.stringify(commit)}\n`, { mode: 0o600 });

  assert.throws(
    () => withFileLockSync(join(root, "lock"), "recovery", () => recoverFileTransactionSync(root)),
    FileStorageIntegrityError,
  );
  assert.equal(await readFile(join(root, "first.json"), "utf8"), '{"revision":1}\n');
  assert.equal(await readFile(join(root, "second.json"), "utf8"), '{"revision":1}\n');
});

test("a forged append hash is rejected before any transaction target is applied", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-invalid-append-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "state.json"), '{"revision":1}\n', { mode: 0o600 });
  await writeFile(join(root, "events.jsonl"), '{"eventId":"one"}\n', { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          {
            replacements: [{ relativePath: "state.json", content: '{"revision":2}\n' }],
            appends: [{ relativePath: "events.jsonl", content: '{"eventId":"two"}\n' }],
          },
          {
            transactionId: "forged-append",
            onStage(stage) {
              if (stage === "commit-published") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/u,
  );
  const commitPath = join(root, "commit.json");
  const commit = JSON.parse(await readFile(commitPath, "utf8")) as {
    appends: Array<{ nextHash: string }>;
  };
  commit.appends[0]!.nextHash = "0".repeat(64);
  await writeFile(commitPath, `${JSON.stringify(commit)}\n`, { mode: 0o600 });

  assert.throws(
    () => withFileLockSync(join(root, "lock"), "recovery", () => recoverFileTransactionSync(root)),
    /Append payload hash mismatch/u,
  );
  assert.equal(await readFile(join(root, "state.json"), "utf8"), '{"revision":1}\n');
  assert.equal(await readFile(join(root, "events.jsonl"), "utf8"), '{"eventId":"one"}\n');
});

test("recovery checks every target conflict before applying any target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-conflicting-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "first.json"), '{"revision":1}\n', { mode: 0o600 });
  await writeFile(join(root, "second.json"), '{"revision":1}\n', { mode: 0o600 });

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "fault-injection", () =>
        commitFileTransactionSync(
          root,
          {
            replacements: [
              { relativePath: "first.json", content: '{"revision":2}\n' },
              { relativePath: "second.json", content: '{"revision":2}\n' },
            ],
          },
          {
            transactionId: "conflicting-recovery",
            onStage(stage) {
              if (stage === "commit-published") throw new Error("simulated crash");
            },
          },
        ),
      ),
    /simulated crash/u,
  );
  await writeFile(join(root, "second.json"), '{"revision":99}\n', { mode: 0o600 });

  assert.throws(
    () => withFileLockSync(join(root, "lock"), "recovery", () => recoverFileTransactionSync(root)),
    FileStorageIntegrityError,
  );
  assert.equal(await readFile(join(root, "first.json"), "utf8"), '{"revision":1}\n');
  assert.equal(await readFile(join(root, "second.json"), "utf8"), '{"revision":99}\n');
});

test("file transactions reject an intermediate symlink that escapes the storage root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pico-file-symlink-outside-"));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  const victimPath = join(outside, "victim.jsonl");
  await writeFile(victimPath, '{"outside":true}\n', { mode: 0o600 });
  await symlink(outside, join(root, "escape"), "dir");

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "symlink-check", () =>
        commitFileTransactionSync(root, {
          appends: [
            { relativePath: join("escape", "victim.jsonl"), content: '{"escaped":true}\n' },
          ],
        }),
      ),
    FileStorageIntegrityError,
  );
  assert.equal(await readFile(victimPath, "utf8"), '{"outside":true}\n');
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

test("synchronous file locks fail fast when a callback returns a Promise", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-async-callback-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => withFileLockSync(join(root, "lock"), "sync-owner", async () => undefined),
    /returned a Promise; use withFileLock instead/u,
  );
  assert.equal(
    withFileLockSync(join(root, "lock"), "next-owner", () => "released"),
    "released",
  );
});

test("async file lock timeout includes time queued behind the same process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-local-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");
  let releaseFirst!: () => void;
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const blocker = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withFileLock(lockPath, "first", async () => {
    markHeld();
    await blocker;
  });
  await held;
  await assert.rejects(
    withFileLock(lockPath, "second", async () => undefined, { timeoutMs: 25 }),
    FileLockTimeoutError,
  );
  releaseFirst();
  await first;
  assert.equal(await withFileLock(lockPath, "third", async () => "acquired"), "acquired");
});

test("async file locks reject success after ownership can no longer be proved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-lost-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");

  await assert.rejects(
    withFileLock(lockPath, "owner", async () => {
      await writeFile(join(lockPath, "owner.json"), "{}\n", { mode: 0o600 });
    }),
    /ownership changed|cannot be verified/u,
  );
});

test("synchronous file locks reject success after ownership changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-sync-lost-ownership-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");

  assert.throws(
    () =>
      withFileLockSync(lockPath, "owner", () => {
        const ownerPath = join(lockPath, "owner.json");
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
        owner["leaseId"] = "foreign-lease";
        writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      }),
    /ownership changed/u,
  );
});

test("file lock serializes independent processes and becomes reusable after release", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");
  const heldMarker = join(root, "held");
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "src", "storage", "local-file-storage.ts"),
  ).href;
  const childSource = [
    `import { writeFileSync } from "node:fs";`,
    `import { withFileLockSync } from ${JSON.stringify(moduleUrl)};`,
    `const wait = new Int32Array(new SharedArrayBuffer(4));`,
    `withFileLockSync(${JSON.stringify(lockPath)}, "child", () => {`,
    `  writeFileSync(${JSON.stringify(heldMarker)}, "held");`,
    `  Atomics.wait(wait, 0, 0, 300);`,
    `});`,
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childSource],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childResult = collectChild(child);
  await waitForPath(heldMarker);

  assert.throws(
    () =>
      withFileLockSync(join(root, "lock"), "parent-contender", () => undefined, {
        timeoutMs: 50,
      }),
    FileLockTimeoutError,
  );
  await childResult;

  assert.equal(
    withFileLockSync(join(root, "lock"), "parent-after-release", () => "acquired"),
    "acquired",
  );
});

test("a synchronous nested store reuses the active asynchronous workspace lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-mixed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "lock");
  const result = await withFileLock(lockPath, "async-owner", async () =>
    withFileLockSync(lockPath, "nested-sync-owner", () => "nested-result"),
  );
  assert.equal(result, "nested-result");
});

test("file lock waits on unverifiable ownership and takes over only after a proven owner crash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-file-lock-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const malformedLock = join(root, "malformed-lock");
  await writeFile(join(root, "placeholder"), "ready");
  await mkdir(malformedLock, { mode: 0o700 });
  assert.throws(
    () =>
      withFileLockSync(malformedLock, "must-not-steal", () => undefined, {
        timeoutMs: 30,
      }),
    FileLockTimeoutError,
  );

  const crashLock = join(root, "crash-lock");
  const heldMarker = join(root, "crash-held");
  const moduleUrl = pathToFileURL(
    join(process.cwd(), "src", "storage", "local-file-storage.ts"),
  ).href;
  const childSource = [
    `import { writeFileSync } from "node:fs";`,
    `import { withFileLockSync } from ${JSON.stringify(moduleUrl)};`,
    `withFileLockSync(${JSON.stringify(crashLock)}, "crashing-child", () => {`,
    `  writeFileSync(${JSON.stringify(heldMarker)}, "held");`,
    `  process.exit(0);`,
    `});`,
  ].join("\n");
  await collectChild(
    spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childSource], {
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  assert.equal(await readFile(heldMarker, "utf8"), "held");
  assert.equal(
    withFileLockSync(crashLock, "recovery-owner", () => "recovered", {
      staleAfterMs: 0,
      timeoutMs: 200,
    }),
    "recovered",
  );
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function collectChild(child: ReturnType<typeof spawn>): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("close", (code) => {
      if (code === 0) resolveChild();
      else rejectChild(new Error(`lock child exited with ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}
