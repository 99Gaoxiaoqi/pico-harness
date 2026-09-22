import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { operationalDatabasePath } from "@pico/storage";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import {
  capturePreparedProviderRequest,
  parsePreparedRequestCapture,
} from "@pico/runtime/provider-request-diagnostics";
import { estimateModelInputTokens } from "@pico/runtime/context-budget";
import {
  createCurrentContextSections,
  foldContextComposition,
  getLatestContextRequest,
} from "../../../packages/pico-host/src/session-context-composition.js";
import { contextView } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorPanelController.js";
import { InspectorWorkbarPanel } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";
Object.assign(globalThis, { React });

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
      tools: Array.from({ length: 12 }, (_, i) => ({
        type: "function",
        name: `tool_${i}`,
        description: "私密描述".repeat(i + 1),
        parameters: { type: "object" },
      })),
      unknown_option: { credential: "SECRET_KEY" },
    },
  });
}

test("prepared request composition reaches Inspector with closed byte totals, bounded tools, and no bodies", () => {
  const diagnostic = capture();
  const restored = parsePreparedRequestCapture(diagnostic)!;
  assert.equal(restored.provider, "responses");
  assert.equal(restored.segments.filter((s) => s.kind === "tool_schema")[0]!.label, "tool_0");
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
  assert.equal(
    composition.segments.reduce((n, s) => n + s.bytes, 0),
    composition.totalBytes,
  );
  assert.equal(composition.tools.length, 8);
  assert.equal(composition.remainingTools.count, 4);
  assert.equal(
    composition.tools.reduce(
      (n, s) => n + s.bytes,
      composition.remainingTools.bytes + composition.unlabelledToolBytes,
    ),
    composition.segments.find((s) => s.kind === "tools")!.bytes,
  );
  assert.ok(
    composition.totalBytes !== diagnostic.requestBytes,
    "semantic bytes do not impersonate wire bytes",
  );
  const messages = [
    { role: "system" as const, content: "系统指令" },
    {
      role: "user" as const,
      content: "中文文本",
      images: [{ type: "image_base64" as const, mimeType: "image/png", data: "SECRET_BASE64" }],
    },
  ];
  const missingTools = createCurrentContextSections(messages);
  assert.equal(missingTools[1]!.tokens, undefined);
  assert.equal(missingTools[1]!.state, "unknown");
  const sections = createCurrentContextSections(messages);
  assert.equal(sections[0]!.state, "unknown");
  assert.equal(sections[0]!.tokens, undefined);
  assert.equal(
    sections.reduce((n, s) => n + (s.tokens ?? 0), 0),
    estimateModelInputTokens(messages, []),
  );
  assert.equal(sections.at(-1)!.tokens, undefined);
  const view = contextView({
    version: 2,
    sessionId: "s",
    generatedAt: 1,
    traceWatermark: 2,
    sections,
    latestRequest: {
      status: "available",
      source: "physical",
      providerCallId: "call",
      physicalAttemptId: "physical",
      providerId: "responses",
      modelId: "model-a",
      inputTokens: 999,
      composition,
    },
  });
  const html = renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      context: view,
      trace: [],
      loading: false,
      onRefresh() {},
      onSelectTrace() {},
    }),
  );
  for (const label of [
    "当前模型历史（估算）",
    "最近成功主请求",
    "UTF-8",
    "不是 Token",
    "其余 4 项工具定义",
    "附件及协议开销（未估算）",
    "physical",
    "999",
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /SECRET_|私人正文/u);
});

test("SQLite context selects one successful main request, never borrows missing composition or mixes usage", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-context-composition-"));
  const store = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    let latest = getLatestContextRequest(root, "s");
    assert.equal(latest.status, "unavailable");
    const db = new DatabaseSync(operationalDatabasePath(root));
    try {
      const insert = (id: string, completedAt: string, extra: object = {}) =>
        db
          .prepare(
            "INSERT INTO usage_physical_attempts(physical_attempt_id,provider_call_id,session_id,status,record_json,owner_id,revision,created_at) VALUES(?,?,?,'succeeded',?,'fixture',1,'2026-09-22T00:00:00Z')",
          )
          .run(
            id,
            id,
            "s",
            JSON.stringify({
              accountingSource: "physical",
              provider: "responses",
              model: "model-a",
              purpose: "main",
              completedAt,
              requestDiagnostic: capture(),
              usage: {
                promptTokens: 77,
                completionTokens: 2,
                cacheReadTokens: 12,
                reportedFields: ["prompt", "completion", "cacheRead"],
              },
              ...extra,
            }),
          );
      insert("physical", "2026-09-22T00:00:00Z");
      insert("physical-compaction", "2026-09-22T01:00:00Z", {
        purpose: "compaction",
        usage: { promptTokens: 7777 },
      });
      latest = getLatestContextRequest(root, "s");
      assert.equal(latest.physicalAttemptId, "physical");
      assert.equal(latest.inputTokens, 77);
      assert.equal(latest.cachedInputTokens, 12);
      assert.equal(latest.status, "available");
      insert("new-model", "2026-09-22T02:00:00Z", {
        model: "model-b",
        requestDiagnostic: null,
        usage: { promptTokens: 22, reportedFields: ["prompt"] },
      });
      latest = getLatestContextRequest(root, "s");
      assert.equal(latest.physicalAttemptId, "new-model");
      assert.equal(latest.modelId, "model-b");
      assert.equal(latest.status, "unavailable");
      assert.equal(latest.inputTokens, 22);
      assert.equal(latest.cachedInputTokens, undefined);
    } finally {
      db.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
