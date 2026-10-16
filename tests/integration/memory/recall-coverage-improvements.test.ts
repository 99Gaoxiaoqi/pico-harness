import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { before, after } from "node:test";
import type { MemoryItemWrite, TaskExperienceCandidate } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { experienceSummary } from "../../../packages/storage/src/sqlite/task-experience-policy.js";
import { AtomicMemoryContextBuilder } from "../../../packages/runtime/src/atomic-memory/context-builder.js";
import {
  taskExperienceRecallTargets,
  searchTaskExperienceCases,
} from "../../../packages/pico-host/src/task-experience-recall.js";

// One frozen synthetic corpus; no user state or model/provider is opened.
const workspaceKey = "recall-coverage-fixture";
const workDir = "/fixture/recall";
let root: string;
let store: SqliteMemoryItemStore;
let db: DatabaseSync;
let clock = 1;
const items = new Map<string, { id: string; version: number }>();
function memory(
  content: string,
  key: string,
  fields: Partial<MemoryItemWrite> = {},
): MemoryItemWrite {
  return {
    content,
    kind: "knowledge",
    statementType: "fact",
    temporalType: "undated",
    scopeType: "workspace",
    scopeKey: workspaceKey,
    observedAt: 1,
    origin: "user_requested",
    keys: [{ key, keyType: "concept", keyOrigin: "user" }],
    sources: [],
    ...fields,
  };
}
async function item(
  name: string,
  content: string,
  key = "unrelated",
  fields: Partial<MemoryItemWrite> = {},
) {
  const {
    results: [result],
  } = await store.applyMutations({
    operationId: `seed-${name}`,
    mutations: [{ type: "create", item: memory(content, key, fields) }],
  });
  assert.ok(result);
  items.set(name, { id: result.itemId, version: result.version });
  return result.itemId;
}
async function candidate(
  id: string,
  fields: Partial<TaskExperienceCandidate> = {},
  withItem = true,
) {
  const content = fields.content ?? `Historical method ${id} keeps its own scope.`;
  const itemId = withItem ? await item(id, content) : undefined;
  const value: TaskExperienceCandidate = {
    candidateId: id,
    contentVersion: 1,
    recordRevision: 1,
    review: "approved",
    validation: "unknown",
    enabled: true,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    representation: "method",
    usagePolicy: "suggestion",
    matchHints: [id],
    requiredConditions: [],
    kind: "task-lesson",
    lifecycleState: "active",
    taskId: `task-${id}`,
    taskVersion: 1,
    workspaceKey,
    workDir,
    sessionId: "fixture",
    runId: "fixture-run",
    failureKey: `failure-${id}`,
    inputEpoch: 0,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "saved",
    goal: `Goal ${id}`,
    content,
    sources: [],
    observationIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...(itemId ? { itemId } : {}),
    ...fields,
  };
  db.prepare(
    "INSERT INTO execution_learning_candidates(candidate_id,workspace_key,session_id,run_id,failure_key,state,revision,item_id,updated_at,record_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    value.workspaceKey,
    value.sessionId,
    value.runId,
    value.failureKey,
    value.state,
    1,
    value.itemId ?? null,
    value.updatedAt,
    JSON.stringify(value),
  );
  if (value.itemId) {
    const record = await store.readItem(value.itemId);
    assert.ok(record);
    db.prepare(
      "INSERT INTO execution_learning_items(item_id,candidate_id,item_content_hash,source_type,metadata_json) VALUES(?,?,?,?,?)",
    ).run(
      value.itemId,
      id,
      record.item.contentHash,
      "reviewed-reference",
      JSON.stringify(experienceSummary(value)),
    );
  }
  return value;
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), "pico-recall-coverage-"));
  const file = join(root, "memory.sqlite");
  store = new SqliteMemoryItemStore(file, { now: () => clock++ });
  db = new DatabaseSync(file);
  for (let i = 0; i < 12; i++) await candidate(`oldmethod${i}`);
  for (let i = 0; i < 12; i++)
    await candidate(
      `oldcase${i}`,
      {
        representation: "case",
        usagePolicy: "case_only",
        content: `A historical oldcase${i} reference.`,
        enabled: false,
      },
      false,
    );
  // Higher-timestamp unrelated candidates must not form a pre-ranking recent-100 window.
  for (let i = 0; i < 1100; i++)
    await candidate(
      `noise${i}`,
      { updatedAt: 100 + i, matchHints: ["background"], content: "Unrelated background." },
      false,
    );
  for (let i = 0; i < 1100; i++)
    await candidate(
      `case-noise${i}`,
      {
        representation: "case",
        usagePolicy: "case_only",
        updatedAt: 2000 + i,
        content: "Unrelated historical background.",
        matchHints: ["background"],
        enabled: false,
      },
      false,
    );
  for (let i = 0; i < 520; i += 32) {
    await store.applyMutations({
      operationId: `resident-${i}`,
      mutations: Array.from({ length: Math.min(32, 520 - i) }, (_, n) => ({
        type: "create" as const,
        item: memory(`Resident background ${i + n}.`, "background"),
      })),
    });
  }
});
after(async () => {
  db?.close();
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

for (let i = 0; i < 12; i++)
  test(`D-old-${i + 1}: eligible method/case survives recent candidate and resident windows`, async () => {
    const id = `oldmethod${i}`;
    const targets = await taskExperienceRecallTargets({
      store: store.taskExperiences,
      workspaceKey,
      workDir,
      query: id,
      toolAllowed: () => true,
      budgetMs: 5000,
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.candidateId, id);
    assert.equal(targets[0]!.itemId, items.get(id)!.id);
    assert.equal(targets[0]!.itemVersion, 1);
    const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
    assert.equal(
      (await builder.build(id)).items.length,
      0,
      "method cannot bypass Host qualification",
    );
    assert.equal(
      (await builder.build(id, { reviewedExperiences: targets })).items[0]!.item.itemId,
      items.get(id)!.id,
    );
    const selected: string[] = [];
    const block = await searchTaskExperienceCases({
      store: store.taskExperiences,
      workspaceKey,
      workDir,
      query: `oldcase${i}`,
      budgetMs: 5000,
      onSelected: (value) => {
        selected.push(value.candidateId);
        assert.ok(value.renderedLine.includes(`oldcase${i}`));
        assert.equal(value.contentVersion, 1);
        assert.equal(value.range.start, 0);
      },
    });
    assert.deepEqual(selected, [`oldcase${i}`]);
    assert.match(block, /adopted="unknown"/);
  });

const factSentences = [
  "Only when staging passes may longfact0 be enabled.",
  "Never enable longfact1 before checking the current target.",
  "The 2024 observation says longfact2 was disabled.",
  "If the source is unchanged, longfact3 is permitted only in staging.",
  "只有检查范围未变化时，青岚四号才可用于测试环境。",
  "禁止在生产环境启用北辰五号，除非当前检查通过。",
];
for (let i = 0; i < 12; i++)
  test(`D-fact-${i + 1}: whole fact clauses keep conditions and bounded original ranges`, async () => {
    const positive = i < 6;
    const query = positive
      ? i < 4
        ? `longfact${i}`
        : i === 4
          ? "青岚四号"
          : "北辰五号"
      : `unsafe${i}`;
    const clause = positive
      ? factSentences[i]!
      : `Only if ${"条件".repeat(200)} ${query} may be used.`;
    const body = `${"背景。".repeat(380)}\n${clause}\n${"其他。".repeat(100)}`;
    const id = await item(`fact-${i}`, body, query);
    const result = await new AtomicMemoryContextBuilder(store, workspaceKey).build(query, {
      trace: {},
    });
    assert.ok(result.tokenCount <= 320);
    if (positive) {
      assert.equal(result.references.length, 1);
      const reference = result.references[0]!;
      assert.equal(reference.itemId, id);
      assert.ok(reference.excerpt);
      assert.ok(reference.content.includes(clause));
      assert.equal(
        Array.from(result.items[0]!.item.content)
          .slice(reference.range.start, reference.range.end)
          .join(""),
        reference.content,
      );
    } else {
      assert.equal(result.items.length, 0);
      assert.ok(result.diagnostics.some((d) => d.itemId === id && d.reason === "budget"));
    }
  });

for (let i = 0; i < 12; i++)
  test(`D-methods-${i + 1}: search compares bounded independent methods, automatic retains one`, async () => {
    const query = `compare${i}`;
    for (let n = 0; n < 4; n++)
      await candidate(`${query}-${n}`, { matchHints: [query], updatedAt: 3000 + n });
    const targets = await taskExperienceRecallTargets({
      store: store.taskExperiences,
      workspaceKey,
      workDir,
      query,
      toolAllowed: () => true,
      budgetMs: 5000,
    });
    assert.equal(targets.length, 4);
    const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
    const automatic = await builder.build(query, { reviewedExperiences: targets });
    assert.equal(automatic.items.length, 1);
    assert.ok(automatic.tokenCount <= 320);
    const search = await builder.build(query, {
      mode: "search",
      reviewedExperiences: targets,
      trace: {},
    });
    assert.equal(search.items.length, 3);
    assert.ok(search.tokenCount <= 5120);
    assert.equal(new Set(search.references.map((r) => r.itemId)).size, 3);
    assert.ok(search.diagnostics.some((d) => d.reason === "item_limit"));
    for (const reference of search.references)
      assert.ok(reference.applicability?.includes("当前任务仍需核对"));
    const stale = targets.map((target) => ({ ...target, itemVersion: target.itemVersion! + 1 }));
    assert.equal(
      (await builder.build(query, { mode: "search", reviewedExperiences: stale })).items.length,
      0,
    );
  });

const deniedFields: Partial<TaskExperienceCandidate>[] = [
  { workspaceKey: "another-workspace" },
  { workDir: "/other" },
  { review: "rejected" },
  { enabled: false },
  { validation: "fail" },
  { validation: "stale" },
  { expiresAt: 1 },
  { scopeUnresolved: true },
  { lifecycleState: "archived" },
  { state: "invalidated" },
  { applicability: { taskFamily: "coding", toolNames: ["bash"], conditions: [] } },
  {
    requiredConditions: [
      { kind: "spreadsheet-range", operation: "sum", header: false, dataKind: "finite-numbers" },
    ],
  },
];
for (let i = 0; i < 12; i++)
  test(`D-guard-${i + 1}: qualification applies before query limit and never grants authority`, async () => {
    const query = `guard${i}`;
    const fields = deniedFields[i]!;
    await candidate(`${query}-bad`, { ...fields, matchHints: [query], updatedAt: 9000 });
    await candidate(`${query}-good`, { matchHints: [query], updatedAt: 1 });
    const targets = await taskExperienceRecallTargets({
      store: store.taskExperiences,
      workspaceKey,
      workDir,
      query,
      toolAllowed: () => false,
      conditionMatches: async () => false,
      budgetMs: 5000,
    });
    assert.deepEqual(
      targets.map((t) => t.candidateId),
      [`${query}-good`],
    );
  });

test("D-query: stable ranked TopK, all-scope eligibility and bounded deadline diagnostic", async () => {
  for (const id of ["tie-c", "tie-b", "tie-a"])
    await candidate(id, { matchHints: ["tie"], updatedAt: 9000 });
  const ranked = await store.taskExperiences.queryTaskExperiences(workspaceKey, {
    limit: 2,
    recall: { score: (c) => (c.candidateId.startsWith("tie-") ? 4 : 0), budgetMs: 5000 },
  });
  assert.deepEqual(
    ranked.map((c) => c.candidateId),
    ["tie-a", "tie-b"],
  );
  const accepted = await store.taskExperiences.queryTaskExperiences(workspaceKey, {
    limit: 1,
    recall: {
      score: (c) => (c.candidateId.startsWith("tie-") ? 4 : 0),
      accept: (c) => c.candidateId === "tie-c",
      budgetMs: 5000,
    },
  });
  assert.deepEqual(
    accepted.map((c) => c.candidateId),
    ["tie-c"],
  );
  let limited: unknown;
  const before = performance.now();
  const result = await store.taskExperiences.queryTaskExperiences(workspaceKey, {
    recall: {
      score: () => 1,
      accept: () => new Promise<boolean>(() => {}),
      budgetMs: 20,
      onLimited: (value) => {
        limited = value;
      },
    },
  });
  assert.deepEqual(result, []);
  assert.ok(limited);
  assert.ok(performance.now() - before < 1000);
});
