import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath } from "@pico/storage";
import type { PhysicalAttemptRecord } from "@pico/storage/runtime-control-types";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import {
  capturePreparedProviderRequest,
  parsePreparedRequestCapture,
} from "@pico/runtime/provider-request-diagnostics";
import {
  foldContextComposition,
  getLatestContextRequest,
} from "../../../packages/pico-host/src/session-context-composition.js";

function capture(model = "model-a") {
  return capturePreparedProviderRequest({
    provider: "responses",
    model,
    body: {
      model,
      instructions: "秘密系统指令 中文文本",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "私人正文" },
            { type: "input_image", image_url: "data:image/png;base64,SECRET_BASE64" },
          ],
        },
      ],
      tools: Array.from({ length: 80 }, (_, i) => ({
        type: "function",
        name: `tool_${i}`,
        description: "私密描述".repeat(i + 1),
        parameters: { type: "object" },
      })),
      unknown_option: { credential: "SECRET_KEY" },
    },
  });
}

test("prepared composition retains sixty-four named tools and the complete remainder without bodies", () => {
  const diagnostic = capture();
  const restored = parsePreparedRequestCapture(diagnostic)!;
  assert.doesNotMatch(JSON.stringify(diagnostic), /秘密|私人正文|私密描述|SECRET_/u);
  const unnamed = foldContextComposition(
    restored.segments.map(({ label: _label, ...segment }) => segment),
  )!;
  assert.equal(unnamed.tools.length, 0);
  assert.equal(
    unnamed.unlabelledToolBytes,
    unnamed.segments.find((s) => s.kind === "tools")!.bytes,
  );
  const composition = foldContextComposition([
    ...restored.segments,
    { kind: "future_kind", bytes: 19 },
  ])!;
  assert.equal(
    composition.totalBytes,
    restored.segments.reduce((n, s) => n + s.bytes, 19),
  );
  assert.equal(composition.tools.length, 64);
  assert.equal(composition.remainingTools.count, 16);
  assert.equal(
    composition.tools.reduce((n, s) => n + s.bytes, composition.remainingTools.bytes),
    composition.segments.find((s) => s.kind === "tools")!.bytes,
  );
  assert.notEqual(composition.totalBytes, diagnostic.requestBytes);
});

test("settled request snapshot is atomic, immutable, monotonic, repairable and independent of missing composition", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-context-snapshot-"));
  let store = new SqliteRuntimeControlStore({ storageRoot: root });
  const db = new DatabaseSync(operationalDatabasePath(root));
  try {
    assert.equal(getLatestContextRequest(root, "s").status, "unavailable");
    const ownerId = store.beginPhysicalAttemptOwner();
    const make = (
      id: string,
      extra: Partial<PhysicalAttemptRecord> = {},
    ): PhysicalAttemptRecord => ({
      physicalAttemptId: id,
      providerCallId: id,
      logicalCallId: id,
      ownerId,
      accountingVersion: 1,
      accountingSource: "physical",
      sessionId: "s",
      purpose: "main",
      provider: "responses",
      model: "model-a",
      attempt: 1,
      revision: 0,
      retryAttempt: 0,
      status: "prepared",
      startedAt: "2026-09-23T00:00:00.000Z",
      usageBasis: "missing",
      costStatus: "unknown",
      pricingVersion: "fixture",
      contextFacts: {
        version: 1,
        routeId: "p/model-a",
        connectionId: "p",
        contextWindow: 10000,
        contextWindowSource: "config",
        compaction: {
          checkpointId: "cp-at-request",
          throughEventId: "event-1",
          coveredEventCount: 4,
        },
      },
      requestDiagnostic: capture() as unknown as Record<string, unknown>,
      ...extra,
    });
    const settle = (
      record: PhysicalAttemptRecord,
      completedAt: string,
      extra: Partial<PhysicalAttemptRecord> = {},
    ) => {
      store.recordPhysicalAttempt(record);
      const done: PhysicalAttemptRecord = {
        ...record,
        revision: 1,
        status: "succeeded",
        completedAt,
        usageBasis: "reported",
        usage: {
          promptTokens: 77,
          completionTokens: 2,
          cacheReadTokens: 12,
          reportedFields: ["prompt", "completion", "cacheRead"],
        },
        ...extra,
      };
      store.recordPhysicalAttempt(done);
      return done;
    };
    const first = settle(make("first"), "2026-09-23T00:00:02.000Z");
    const frozen = getLatestContextRequest(root, "s");
    assert.equal(frozen.inputTokens, 77);
    assert.equal(frozen.contextWindow, 10000);
    assert.equal(frozen.cachedInputTokens, 12);
    assert.equal(frozen.compaction?.checkpointId, "cp-at-request");
    assert.equal(frozen.compositionStatus, "available");
    assert.throws(
      () =>
        store.recordPhysicalAttempt({
          ...first,
          revision: 2,
          contextFacts: { version: 1, contextWindow: 20000 },
        }),
      /immutable/,
    );
    settle(make("late-old"), "2026-09-23T00:00:01.000Z");
    settle(make("summary", { purpose: "compaction" }), "2026-09-23T00:00:03.000Z");
    settle(make("hook", { purpose: "hook" }), "2026-09-23T00:00:04.000Z");
    settle(make("failed"), "2026-09-23T00:00:05.000Z", { status: "failed" });
    assert.deepEqual(getLatestContextRequest(root, "s"), frozen);
    // Ten thousand canonical requests cannot turn healthy projection reads into a ledger scan.
    db.exec("BEGIN");
    const insert = db.prepare(`INSERT INTO usage_physical_attempts
      (physical_attempt_id,provider_call_id,session_id,owner_id,revision,status,created_at,record_json)
      VALUES (?,?,?, ?,1,'succeeded',?,?)`);
    for (let i = 0; i < 10000; i++) {
      const id = `historical-${i}`;
      const record = {
        ...first,
        physicalAttemptId: id,
        providerCallId: id,
        completedAt: "2026-09-23T00:00:00.000Z",
        requestDiagnostic: undefined,
      };
      insert.run(id, id, "s", ownerId, record.startedAt, JSON.stringify(record));
    }
    db.exec("COMMIT");
    const queryPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT record_json FROM usage_physical_attempts
      WHERE session_id=? AND status='succeeded' AND json_extract(record_json,'$.purpose')='main'
      AND json_extract(record_json,'$.contextFacts.version')=1
      ORDER BY json_extract(record_json,'$.completedAt') DESC, physical_attempt_id DESC LIMIT 1`,
      )
      .all("s");
    assert.match(JSON.stringify(queryPlan), /usage_latest_context_repair/);
    assert.doesNotMatch(JSON.stringify(queryPlan), /TEMP B-TREE|SCAN usage/);
    const started = performance.now();
    for (let i = 0; i < 1000; i++)
      assert.equal(store.getLatestContextAttempt("s")?.physicalAttemptId, "first");
    assert.ok(
      performance.now() - started < 1000,
      "1000 healthy reads over 10000 records under one second",
    );
    const revision = store.getAccountingRevision();
    for (let i = 0; i < 3; i++) assert.deepEqual(getLatestContextRequest(root, "s"), frozen);
    assert.equal(store.getAccountingRevision(), revision);
    db.prepare("UPDATE session_latest_context SET record_json='{}' WHERE session_id='s'").run();
    assert.deepEqual(
      getLatestContextRequest(root, "s"),
      frozen,
      "repair only reads canonical current-format facts",
    );
    const latest = settle(
      make("latest", {
        model: "model-b",
        requestDiagnostic: undefined,
        contextFacts: { version: 1, routeId: "q/model-b", connectionId: "q" },
      }),
      "2026-09-23T00:00:06.000Z",
      {
        usageBasis: "partial",
        usage: { promptTokens: 22, completionTokens: 0, reportedFields: ["prompt"] },
      },
    );
    const view = getLatestContextRequest(root, "s");
    assert.equal(view.physicalAttemptId, latest.physicalAttemptId);
    assert.equal(view.status, "available");
    assert.equal(view.compositionStatus, "unrecorded");
    assert.equal(view.usageStatus, "partial");
    assert.equal(view.inputTokens, 22);
    assert.equal(view.outputTokens, undefined);
    assert.equal(view.contextWindow, undefined);
    assert.equal(view.compaction, undefined);
    assert.equal(view.cachedInputTokens, undefined);
    store.close();
    store = new SqliteRuntimeControlStore({ storageRoot: root });
    assert.deepEqual(getLatestContextRequest(root, "s"), view);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
