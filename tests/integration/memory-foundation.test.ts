import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  MemoryAsyncTransactionError,
  MemoryConflictError,
  MemoryIdempotencyConflictError,
  MemoryRepository,
} from "../../src/memory/memory-repository.js";
import { FileStorageIntegrityError } from "../../src/storage/local-file-storage.js";
import type { WorkspaceId } from "../../src/paths/pico-paths.js";

const execFileAsync = promisify(execFile);

test("MemoryRepository rejects an empty storage root", () => {
  assert.throws(
    () =>
      new MemoryRepository({
        storageRoot: " ",
        workspaceId: "workspace-empty-root" as WorkspaceId,
      }),
    /storageRoot must not be empty/u,
  );
});

test("memory JSON snapshot persists the complete structured model", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);

  const source = repository.createSource({
    sourceId: "source-1",
    sessionId: "session-1",
    eventIds: ["event-1"],
    digest: "sha256:digest",
  });
  const fact = repository.createFact({
    factId: "fact-1",
    kind: "project_fact",
    title: "title",
    content: "content",
    sourceId: source.sourceId,
  });
  const proposal = repository.createProposal({
    proposalId: "proposal-1",
    kind: "correction",
    title: "proposal",
    content: "replacement",
    reason: "reason",
    sourceId: source.sourceId,
  });
  repository.createJob({
    jobId: "job-1",
    type: "extract",
    terminalEventId: "terminal-1",
    extractorVersion: "v1",
    cursor: { sessionId: "session-1", sequence: 1 },
  });
  repository.updateSettings({ expectedVersion: 1, autoCommit: true });
  repository.close();

  const reopened = open(fixture);
  assert.deepEqual(reopened.getFact(fact.factId), fact);
  assert.deepEqual(reopened.getProposal(proposal.proposalId), proposal);
  assert.equal(reopened.getSettings().autoCommit, true);
  assert.equal(reopened.listJobs().length, 1);
  const state = JSON.parse(await readFile(join(fixture.storageRoot, "state.json"), "utf8")) as {
    schemaVersion: number;
    workspaceId: string;
    revision: number;
    mutations: unknown[];
    idempotency: object;
  };
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.workspaceId, fixture.workspaceId);
  assert.ok(state.revision >= 5);
  assert.ok(state.mutations.length >= 5);
  assert.deepEqual(state.idempotency, {});
  assert.equal(existsSync(join(fixture.storageRoot, "memory.sqlite")), false);
});

test("retrying a failed memory job clears its terminal timestamp", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const queued = repository.createJob({
    jobId: "job-retry",
    type: "extract",
    terminalEventId: "terminal-retry",
    extractorVersion: "v1",
    cursor: { sessionId: "session-retry", sequence: 1 },
  });
  const failed = repository.updateJob({
    jobId: queued.jobId,
    expectedVersion: queued.version,
    status: "failed",
  });
  assert.ok(failed.terminalAt);

  const running = repository.updateJob({
    jobId: failed.jobId,
    expectedVersion: failed.version,
    status: "running",
  });
  assert.equal(running.terminalAt, undefined);
  repository.close();
  assert.equal(open(fixture).listJobs()[0]?.terminalAt, undefined);
});

test("transaction is nested, synchronous and commits one snapshot revision", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const before = await revision(fixture.storageRoot);

  repository.transaction((outer) => {
    outer.createFact({
      factId: "fact-a",
      kind: "preference",
      title: "A",
      content: "A body",
    });
    outer.transaction((inner) => {
      inner.createFact({
        factId: "fact-b",
        kind: "preference",
        title: "B",
        content: "B body",
      });
    });
  });
  assert.equal(await revision(fixture.storageRoot), before + 1);

  assert.throws(
    () =>
      repository.transaction(() => {
        repository.createFact({
          factId: "rolled-back",
          kind: "reference",
          title: "rollback",
          content: "rollback body",
        });
        throw new Error("rollback");
      }),
    /rollback/u,
  );
  assert.equal(repository.getFact("rolled-back"), undefined);

  assert.throws(
    () =>
      // @ts-expect-error The public type rejects Promise-like transaction results.
      repository.transaction(async () => undefined),
    MemoryAsyncTransactionError,
  );
});

test("idempotency replays the marker and rejects another request", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const first = repository.createFact({
    factId: "fact-idempotent",
    kind: "preference",
    title: "stable",
    content: "stable body",
    idempotencyKey: "request-1",
  });
  const replay = repository.createFact({
    factId: "fact-idempotent",
    kind: "preference",
    title: "stable",
    content: "stable body",
    idempotencyKey: "request-1",
  });
  assert.deepEqual(replay, first);
  assert.throws(
    () =>
      repository.createFact({
        factId: "fact-other",
        kind: "preference",
        title: "changed",
        content: "changed body",
        idempotencyKey: "request-1",
      }),
    MemoryIdempotencyConflictError,
  );
});

test("two repository instances serialize CAS writes and observe current state", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = open(fixture);
  const second = open(fixture);
  const fact = first.createFact({
    factId: "fact-cas",
    kind: "project_fact",
    title: "one",
    content: "one",
  });
  const updated = second.updateFact({
    factId: fact.factId,
    expectedVersion: fact.version,
    title: "two",
  });
  assert.equal(first.getFact(fact.factId)?.title, "two");
  assert.throws(
    () => first.updateFact({ factId: fact.factId, expectedVersion: fact.version, title: "lost" }),
    MemoryConflictError,
  );
  assert.equal(first.getFact(fact.factId)?.version, updated.version);
});

test("independent processes serialize snapshot writes without losing facts", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  open(fixture).close();
  const script = `
    import { MemoryRepository } from "./src/memory/memory-repository.ts";
    const [storageRoot, workspaceId, prefix] = process.argv.slice(1);
    const repository = new MemoryRepository({ storageRoot, workspaceId, busyTimeoutMs: 10000 });
    for (let index = 0; index < 5; index++) {
      repository.createFact({
        factId: prefix + "-" + index,
        kind: "project_fact",
        title: prefix + " title " + index,
        content: prefix + " content " + index
      });
    }
  `;
  const run = (prefix: string) =>
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        script,
        fixture.storageRoot,
        fixture.workspaceId,
        prefix,
      ],
      { cwd: process.cwd() },
    );
  await Promise.all([run("process-a"), run("process-b")]);
  const facts = open(fixture).listFacts({ limit: 20 });
  assert.equal(facts.length, 10);
  assert.deepEqual(
    new Set(facts.map((fact) => fact.factId)),
    new Set(
      Array.from({ length: 5 }, (_, index) => [`process-a-${index}`, `process-b-${index}`]).flat(),
    ),
  );
});

test("future schema and workspace mismatch fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  open(fixture).close();
  const statePath = join(fixture.storageRoot, "state.json");
  const original = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;

  await writeFile(statePath, `${JSON.stringify({ ...original, schemaVersion: 2 })}\n`);
  assert.throws(() => open(fixture), FileStorageIntegrityError);

  await writeFile(statePath, `${JSON.stringify({ ...original, workspaceId: "another" })}\n`);
  assert.throws(() => open(fixture), FileStorageIntegrityError);
});

test("malformed structured memory entities fail closed", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const source = repository.createSource({
    sourceId: "source-corrupt",
    sessionId: "session-corrupt",
    digest: "sha256:corrupt",
  });
  repository.createFact({
    factId: "fact-corrupt",
    kind: "project_fact",
    title: "fact",
    content: "body",
    sourceId: source.sourceId,
    idempotencyKey: "fact-corrupt-create",
  });
  repository.createProposal({
    proposalId: "proposal-corrupt",
    kind: "correction",
    title: "proposal",
    content: "body",
    reason: "reason",
    sourceId: source.sourceId,
  });
  repository.createJob({
    jobId: "job-corrupt",
    type: "extract",
    terminalEventId: "terminal-corrupt",
    extractorVersion: "v1",
    cursor: { sessionId: "session-corrupt", sequence: 1 },
  });
  repository.close();
  const statePath = join(fixture.storageRoot, "state.json");
  const original = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  interface CorruptibleMemoryState {
    settings: Record<string, unknown>;
    sources: Record<string, Record<string, unknown>>;
    facts: Record<string, Record<string, unknown>>;
    proposals: Record<string, Record<string, unknown>>;
    mutations: Array<Record<string, unknown>>;
    jobs: Record<string, Record<string, unknown> & { cursor: Record<string, unknown> }>;
    idempotency: Record<string, Record<string, unknown>>;
  }
  const corruptions: Array<(state: CorruptibleMemoryState) => void> = [
    (state) => {
      state.settings.enabled = "yes";
    },
    (state) => {
      state.sources["source-corrupt"]!.eventIds = [42];
    },
    (state) => {
      state.facts["fact-corrupt"]!.kind = "invented";
    },
    (state) => {
      state.facts["fact-corrupt"]!.title = null;
      state.facts["fact-corrupt"]!.content = null;
    },
    (state) => {
      state.proposals["proposal-corrupt"]!.status = "unknown";
    },
    (state) => {
      state.proposals["proposal-corrupt"]!.title = null;
      state.proposals["proposal-corrupt"]!.content = null;
      state.proposals["proposal-corrupt"]!.reason = null;
    },
    (state) => {
      state.mutations[0]!.action = "fact.body-copied";
    },
    (state) => {
      state.jobs["job-corrupt"]!.cursor.sequence = -1;
    },
    (state) => {
      state.jobs["job-corrupt"]!.terminalAt = "2026-07-25T12:00:00.000Z";
    },
    (state) => {
      const idempotency = Object.values(state.idempotency)[0] as Record<string, unknown>;
      idempotency.marker = { factId: 42 };
    },
    (state) => {
      state.facts["fact-corrupt"]!.sourceId = "missing-source";
    },
    (state) => {
      state.jobs["job-duplicate"] = {
        ...structuredClone(state.jobs["job-corrupt"]!),
        jobId: "job-duplicate",
      };
    },
    (state) => {
      const mutation = structuredClone(state.mutations[0]!);
      mutation.sequence = state.mutations.length + 1;
      state.mutations.push(mutation);
    },
  ];
  for (const corrupt of corruptions) {
    const state = structuredClone(original) as unknown as CorruptibleMemoryState;
    corrupt(state);
    await writeFile(statePath, `${JSON.stringify(state)}\n`);
    assert.throws(() => open(fixture), FileStorageIntegrityError);
  }
});

test("forget atomically clears fact and linked proposal bodies from live files", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const title = "FORGET_SECRET_TITLE_9eb7";
  const content = "FORGET_SECRET_CONTENT_a12c";
  const reason = "FORGET_SECRET_REASON_4d51";
  const fact = repository.createFact({
    factId: "fact-forget",
    kind: "correction",
    title,
    content,
  });
  repository.createProposal({
    proposalId: "linked",
    kind: "correction",
    title,
    content,
    reason,
    conflictStatus: "confirmed",
    conflictFactId: fact.factId,
  });
  const staleTemporary = join(fixture.storageRoot, ".state.json.crashed.tmp");
  await writeFile(staleTemporary, `${title}\n${content}\n${reason}\n`);
  const summariesDirectory = join(fixture.storageRoot, "summaries");
  const summaryTemporary = join(summariesDirectory, ".state.json.concurrent.tmp");
  await mkdir(summariesDirectory);
  await writeFile(summaryTemporary, `${title}\n${content}\n${reason}\n`);

  const forgetInput = {
    factId: fact.factId,
    expectedVersion: fact.version,
    idempotencyKey: "forget-fact",
  } as const;
  const forgotten = repository.forgetFact(forgetInput);
  assert.equal(forgotten.state, "forgotten");
  assert.equal(forgotten.title, null);
  assert.equal(forgotten.content, null);
  assert.equal(repository.getProposal("linked")?.status, "deleted");
  const stored = await readFile(join(fixture.storageRoot, "state.json"), "utf8");
  for (const secret of [title, content, reason]) assert.equal(stored.includes(secret), false);
  assert.equal(existsSync(staleTemporary), false);
  assert.equal(existsSync(summaryTemporary), true);

  const replayTemporary = join(fixture.storageRoot, ".commit.json.replay.tmp");
  await writeFile(replayTemporary, `${title}\n${content}\n${reason}\n`);
  assert.deepEqual(repository.forgetFact(forgetInput), forgotten);
  assert.equal(existsSync(replayTemporary), false);
  assert.equal(existsSync(summaryTemporary), true);
});

test("forget preserves another active fact with identical text without reporting failure", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = open(fixture);
  const sharedTitle = "Shared title";
  const sharedContent = "Shared sensitive body";
  const forgotten = repository.createFact({
    factId: "fact-shared-forget",
    kind: "project_fact",
    title: sharedTitle,
    content: sharedContent,
  });
  repository.createFact({
    factId: "fact-shared-retain",
    kind: "project_fact",
    title: sharedTitle,
    content: sharedContent,
  });

  assert.equal(
    repository.forgetFact({
      factId: forgotten.factId,
      expectedVersion: forgotten.version,
      idempotencyKey: "forget-shared",
    }).state,
    "forgotten",
  );
  assert.equal(repository.getFact("fact-shared-retain")?.title, sharedTitle);
  assert.equal(repository.getFact("fact-shared-retain")?.content, sharedContent);
  assert.match(
    await readFile(join(fixture.storageRoot, "state.json"), "utf8"),
    /Shared sensitive body/u,
  );
});

interface Fixture {
  readonly root: string;
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-json-"));
  return {
    root,
    storageRoot: join(root, "memory"),
    workspaceId: "workspace:test" as WorkspaceId,
  };
}

function open(fixture: Fixture): MemoryRepository {
  return new MemoryRepository({
    storageRoot: fixture.storageRoot,
    workspaceId: fixture.workspaceId,
    now: () => new Date("2026-07-25T12:00:00.000Z"),
  });
}

async function revision(storageRoot: string): Promise<number> {
  const state = JSON.parse(await readFile(join(storageRoot, "state.json"), "utf8")) as {
    revision: number;
  };
  return state.revision;
}
