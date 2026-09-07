import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ensureAtomicMemoryWorkspace } from "../../src/memory/atomic/migration.js";
import { memorySessionKey } from "../../src/memory/atomic/runtime-contracts.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { MEMORY_SCOPE } from "../../src/storage/sqlite/memory-scope.js";

async function fixture(
  run: (value: {
    root: string;
    workDir: string;
    picoHome: string;
    legacyPath: string;
    workspaceKey: string;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-migration-"));
  const workDir = join(root, "work");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const paths = resolvePicoPaths(workDir, { picoHome });
  await mkdir(paths.workspace.root, { recursive: true });
  try {
    await run({
      root,
      workDir,
      picoHome,
      legacyPath: join(paths.workspace.root, "pico.sqlite"),
      workspaceKey: paths.workspace.id,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function legacyFixture(path: string, workspaceKey: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(MEMORY_SCOPE.migrations.get(1)!);
    const settings = {
      workspaceId: workspaceKey,
      enabled: false,
      autoPropose: true,
      injectionEnabled: false,
      autoCommit: false,
      reviewMode: "eco",
      version: 8,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    for (const [key, value] of [
      ["workspaceId", workspaceKey],
      ["settings", settings],
      ["revision", 12],
    ] as const)
      db.prepare("INSERT INTO memory_metadata VALUES (?, ?)").run(key, JSON.stringify(value));
    for (const [id, events, suppressed] of [
      ["kept", ["event-kept"], null],
      ["forgotten", ["event-forgotten"], null],
      ["suppressed", ["event-suppressed"], "2026-01-01T00:00:00Z"],
    ] as const)
      db.prepare(
        `INSERT INTO memory_sources(source_id,session_id,event_ids_json,digest,availability,extraction_suppressed_at,version,created_at,updated_at) VALUES (?, 'session-1', ?, 'digest', 'available', ?, 1, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      ).run(id, JSON.stringify(events), suppressed);
    for (const state of ["active", "disabled", "archived", "forgotten"] as const) {
      db.prepare(
        `INSERT INTO memory_facts(fact_id,kind,title,content,confidence,source_id,state,pinned,version,created_at,updated_at,forgotten_at) VALUES (?, ?, ?, ?, 1, ?, ?, 0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
      ).run(
        `fact-${state}`,
        state === "disabled" ? "correction" : state === "archived" ? "reference" : "preference",
        state === "forgotten" ? null : `Title ${state}`,
        state === "forgotten"
          ? null
          : state === "active"
            ? "长".repeat(4100) + " ".repeat(4100) + "尾"
            : `Body ${state}`,
        state === "forgotten" ? "forgotten" : "kept",
        state,
        state === "forgotten" ? "2026-01-01T00:00:00Z" : null,
      );
    }
    db.prepare(
      `INSERT INTO memory_proposals(proposal_id,kind,title,content,reason,confidence,status,conflict_status,version,created_at,updated_at) VALUES ('pending','preference','Pending','Must not be active','review needed',1,'pending','none',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    ).run();
  } finally {
    db.close();
  }
}

test("migration preserves the legacy database, scopes and chunks facts, preserves gates and source suppression across concurrent processes", async () => {
  await fixture(async ({ workDir, picoHome, legacyPath, workspaceKey }) => {
    legacyFixture(legacyPath, workspaceKey);
    const bytes = await readFile(legacyPath);
    const moduleUrl = new URL("../../src/memory/atomic/migration.ts", import.meta.url).href;
    const code = `const {ensureAtomicMemoryWorkspace}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(await ensureAtomicMemoryWorkspace(process.argv[1],process.argv[2])));`;
    const runChild = () =>
      promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        workDir,
        picoHome,
      ]);
    const children = await Promise.all([runChild(), runChild()]);
    const report = JSON.parse(children[0]!.stdout);
    assert.deepEqual(JSON.parse(children[1]!.stdout), report);
    assert.deepEqual(report.counts, {
      active: 1,
      disabled: 1,
      archived: 1,
      forgotten: 1,
      pending: 1,
    });
    assert.equal(report.importedItems, 6);
    assert.equal(
      report.chunks.find((chunk: { legacyFactId: string }) => chunk.legacyFactId === "fact-active")
        .chunkCount,
      4,
    );
    assert.equal(report.suppressedEvents, 2);
    assert.deepEqual(await readFile(legacyPath), bytes);
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      assert.deepEqual(await store.readSettings(workspaceKey), {
        workspaceKey,
        version: 1,
        enabled: false,
        autoExtract: false,
        recallEnabled: false,
      });
      const active = await store.listItems({ workspaceKey });
      const all = await store.listItems({ workspaceKey, includeArchived: true });
      assert.equal(active.length, 4);
      assert.equal(all.length, 6);
      assert.deepEqual(await store.listItems({ workspaceKey: "unrelated" }), []);
      for (const entry of all) {
        assert.equal(entry.item.scopeKey, workspaceKey);
        assert.equal(entry.item.origin, "user_requested");
        assert.deepEqual(entry.sources, []);
        assert.ok(Array.from(entry.item.content).length <= 2000);
      }
      const contents = (
        await Promise.all(
          active.map(async (entry) => ({
            text: entry.item.content,
            meta: JSON.parse((await store.readMigrationOrigin(entry.item.itemId))!),
          })),
        )
      ).sort((a, b) => a.meta.chunkIndex - b.meta.chunkIndex);
      assert.equal(
        contents
          .map((entry) => entry.text)
          .join("")
          .match(/长/g)?.length,
        4100,
      );
      assert.equal(contents[0]!.meta.origin, "legacy_fact_migration");
      assert.equal(
        all.find((entry) => entry.item.content.includes("Body disabled"))?.item.kind,
        "knowledge",
      );
      assert.equal(
        all.find((entry) => entry.item.content.includes("Body archived"))?.item.kind,
        "note",
      );
      const evidence = (eventId: string) => ({
        sessionId: memorySessionKey(workspaceKey, "session-1"),
        eventId,
        runId: "new-run",
        turnId: "new-turn",
      });
      assert.equal(await store.isEvidenceSuppressed(evidence("event-forgotten")), true);
      assert.equal(await store.isEvidenceSuppressed(evidence("event-suppressed")), true);
      assert.equal(await store.isEvidenceSuppressed(evidence("event-kept")), false);
      const item = active[0]!.item;
      await store.forgetItem({
        itemId: item.itemId,
        expectedVersion: item.version,
        operationId: "forget-migrated",
      });
      assert.equal(await store.isEvidenceSuppressed(evidence("event-kept")), true);
    } finally {
      store.close();
    }
    // Completion does not require reopening or rescanning the preservation source.
    await rename(legacyPath, `${legacyPath}.preserved`);
    assert.deepEqual(await ensureAtomicMemoryWorkspace(workDir, picoHome), report);
    assert.deepEqual(await readFile(`${legacyPath}.preserved`), bytes);
  });
});

test("migration marks empty sources once and rolls back all new state before retrying a failed transaction", async () => {
  await fixture(async ({ workDir, picoHome, workspaceKey, legacyPath }) => {
    const initial = await ensureAtomicMemoryWorkspace(workDir, picoHome);
    assert.equal(initial.status, "no_legacy");
    legacyFixture(legacyPath, workspaceKey);
    assert.deepEqual(await ensureAtomicMemoryWorkspace(workDir, picoHome), initial);
    const path = join(picoHome, "another-memory.sqlite");
    let fail = true;
    const store = new SqliteMemoryItemStore(path, {
      now: () => 1000,
      failpoint: (point) => {
        if (fail && point === "before_operation_write") throw new Error("migration failure");
      },
    });
    const input = {
      workspaceKey,
      reportJson: JSON.stringify({ complete: true }),
      settings: { enabled: false, autoExtract: false, recallEnabled: false },
      items: [
        {
          operationId: "legacy-chunk",
          archived: true,
          originJson: JSON.stringify({ origin: "legacy_fact_migration" }),
          item: {
            content: "Confirmed old preference",
            kind: "preference" as const,
            statementType: "fact" as const,
            temporalType: "undated" as const,
            scopeType: "workspace" as const,
            scopeKey: workspaceKey,
            observedAt: 900,
            origin: "user_requested" as const,
            sources: [],
            keys: [{ key: "confirmed", keyType: "exact" as const, keyOrigin: "user" as const }],
          },
        },
      ],
      suppressedEvents: [{ sessionId: memorySessionKey(workspaceKey, "s"), eventId: "e" }],
    };
    try {
      await assert.rejects(store.commitLegacyMigration(input), /migration failure/);
      assert.equal(await store.readLegacyMigration(workspaceKey), undefined);
      assert.deepEqual(await store.listItems({ workspaceKey, includeArchived: true }), []);
      assert.equal(await store.readOperation("legacy-chunk"), undefined);
      assert.equal((await store.readSettings(workspaceKey)).enabled, true);
      fail = false;
      await store.commitLegacyMigration(input);
      await store.commitLegacyMigration(input);
      assert.equal((await store.listItems({ workspaceKey, includeArchived: true })).length, 1);
      assert.deepEqual(await store.listItems({ workspaceKey }), []);
      assert.equal((await store.readSettings(workspaceKey)).enabled, false);
    } finally {
      store.close();
    }
  });
});
