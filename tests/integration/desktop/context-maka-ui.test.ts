import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseRuntimeResult, type RuntimeSessionContextSnapshot } from "@pico/protocol";
import { InspectorWorkbarPanel } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorWorkbarPanel.js";
import { contextView } from "../../../apps/desktop/src/renderer/workbar-panels/InspectorPanelController.js";
import { parseSessionContext } from "../../../apps/desktop/src/renderer/runtime-projections/workspace.js";
import {
  composerContextUsage,
  createContextUsageTracker,
  contextTargetKey,
  type ContextUsageReading,
  type ContextUsageTarget,
} from "../../../apps/desktop/src/renderer/conversation/live-context-usage.js";
import { contextSnapshot } from "./context-maka-fixture.js";
Object.assign(globalThis, { React });
const target: ContextUsageTarget = {
  workspacePath: "/work",
  sessionId: "s",
  routeId: "p/m",
  providerId: "openai",
  modelId: "m",
  connectionId: "p",
  configurationRevision: "v1",
};
function render(snapshot: RuntimeSessionContextSnapshot) {
  const parsed = parseRuntimeResult("session.context.get", { context: snapshot });
  assert.deepEqual(parseSessionContext(parsed), snapshot);
  return renderToStaticMarkup(
    React.createElement(InspectorWorkbarPanel, {
      context: contextView(parsed.context),
      trace: [],
      loading: false,
      onRefresh() {},
      onSelectTrace() {},
    }),
  );
}

test("Maka v3 RPC to Inspector and composer: frozen input, independent history and byte estimates", () => {
  const snapshot = contextSnapshot();
  const complete = contextSnapshot({
    latestRequest: {
      ...snapshot.latestRequest,
      compositionStatus: "available",
      compaction: { checkpointId: "cp-request", throughEventId: "event-2", coveredEventCount: 2 },
      composition: {
        basis: "semantic_utf8_bytes",
        totalBytes: 1000,
        segments: [
          { kind: "system", bytes: 99 },
          { kind: "messages", bytes: 241 },
          { kind: "tools", bytes: 650 },
          { kind: "other", bytes: 10 },
        ],
        tools: Array.from({ length: 8 }, (_, i) => ({ label: `tool-${i}`, bytes: 10 * (i + 1) })),
        remainingTools: { count: 2, bytes: 250 },
        unlabelledToolBytes: 40,
      },
    },
  });
  const html = render(complete);
  assert.match(html, /实际输入 Token<\/dt><dd>2,500/);
  assert.match(html, /其中缓存 Token<\/dt><dd>1,500/);
  assert.match(html, /窗口空余<\/dt><dd>7,500/);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /估算 Token<\/dt><dd>≈300/);
  assert.match(html, /cp-request/);
  assert.match(html, /cp-current/);
  assert.match(html, /≈25 Token · 9.9%/);
  assert.match(html, /其余 5 项工具定义/);
  assert.match(html, /title="310 B">≈78 Token/);
  assert.equal((html.match(/<code>tool-/g) ?? []).length, 5);
  assert.doesNotMatch(html, /<code>tool-[012]<\/code>/);
  assert.deepEqual(composerContextUsage(complete, target), {
    inputTokens: 2500,
    contextWindow: 10000,
    basis: "latest_input",
  });
  assert.equal(
    composerContextUsage(
      contextSnapshot({
        selectedRoute: { ...snapshot.selectedRoute, declaredContextWindow: 20000 },
      }),
      target,
    )?.contextWindow,
    20000,
  );
  const changedHistory = {
    ...complete,
    modelHistory: { ...complete.modelHistory, estimatedTokens: 55, messageCount: 2 },
  };
  assert.equal(composerContextUsage(changedHistory, target)?.inputTokens, 2500);
  assert.match(render(changedHistory), /估算 Token<\/dt><dd>≈55/);
});

test("Maka v3 missing fields and selected-route guards never borrow other request usage", () => {
  const base = contextSnapshot();
  const noComposition = render(base);
  assert.match(noComposition, /实际输入 Token<\/dt><dd>2,500/);
  assert.match(noComposition, /请求组成未知（未记录）/);
  const { inputTokens, ...unmetered } = base.latestRequest;
  assert.equal(inputTokens, 2500);
  const missingUsage = contextSnapshot({
    latestRequest: { ...unmetered, contextWindow: 20000, usageStatus: "missing" },
  });
  assert.match(render(missingUsage), /本次请求没有上报输入用量/);
  assert.doesNotMatch(render(missingUsage), /aria-label="上下文使用率"/);
  assert.equal(composerContextUsage(missingUsage, target), undefined);
  const anchor = {
    routeId: "p/m",
    connectionId: "p",
    modelId: "m",
    inputTokens: 4000,
    outputTokens: 500,
  };
  assert.deepEqual(composerContextUsage({ ...missingUsage, lastRequestAnchor: anchor }, target), {
    inputTokens: 4500,
    contextWindow: 10000,
    basis: "turn_anchor",
  });
  assert.equal(
    composerContextUsage(
      {
        ...missingUsage,
        lastRequestAnchor: anchor,
        selectedRoute: { ...missingUsage.selectedRoute, declaredContextWindow: 30000 },
      },
      target,
    )?.contextWindow,
    30000,
  );
  // Maka fallback uses declared/catalog window, not an unmetered request's frozen window.
  assert.equal(
    composerContextUsage(
      { ...missingUsage, lastRequestAnchor: { ...anchor, connectionId: "different" } },
      target,
    ),
    undefined,
  );
  assert.equal(
    composerContextUsage(base, { ...target, routeId: "p/new", modelId: "new" }),
    undefined,
  );
  assert.equal(
    composerContextUsage(
      { ...base, latestRequest: { ...base.latestRequest, providerId: "claude" } },
      target,
    ),
    undefined,
  );
  assert.equal(
    composerContextUsage(
      { ...base, latestRequest: { ...base.latestRequest, modelId: "old" } },
      target,
    ),
    undefined,
  );
  const { contextWindow, ...withoutWindow } = base.latestRequest;
  assert.equal(contextWindow, 10000);
  const noWindow = { ...base, latestRequest: withoutWindow };
  assert.equal(composerContextUsage(noWindow, target)?.contextWindow, 10000);
  assert.match(render(noWindow), /当时模型窗口<\/dt><dd>未知/);
  assert.doesNotMatch(render(noWindow), /aria-label="上下文使用率"/);
  const withComposition = {
    ...missingUsage,
    latestRequest: {
      ...missingUsage.latestRequest,
      compositionStatus: "available" as const,
      composition: {
        basis: "semantic_utf8_bytes" as const,
        totalBytes: 8,
        segments: [{ kind: "messages" as const, bytes: 8 }],
        tools: [],
        remainingTools: { count: 0, bytes: 0 },
        unlabelledToolBytes: 0,
      },
    },
  };
  assert.match(render(withComposition), /≈2 Token · 100.0%/);
  assert.match(render(withComposition), /本次请求没有上报输入用量/);
  assert.throws(() => parseSessionContext({ context: { version: 2, routeId: "p/m" } }));
});

test("composer request lifecycle integrates coalesced refresh, late results, retained errors and target clearing", async () => {
  const readings: ContextUsageReading[] = [];
  const pending: {
    target: ContextUsageTarget;
    resolve: (value: RuntimeSessionContextSnapshot) => void;
    reject: (error: Error) => void;
  }[] = [];
  const tracker = createContextUsageTracker({
    delayMs: 1,
    onChange: (reading) => readings.push(reading),
    query: (queryTarget) =>
      new Promise((resolve, reject) => pending.push({ target: queryTarget, resolve, reject })),
  });
  try {
    tracker.setTarget(target);
    assert.equal(readings.at(-1)?.snapshot, undefined);
    pending[0]!.resolve(contextSnapshot());
    await delay(0);
    assert.equal(readings.at(-1)?.snapshot?.latestRequest.inputTokens, 2500);
    tracker.setTarget({ ...target });
    assert.equal(pending.length, 1);
    for (let index = 0; index < 10; index++) tracker.observe("s");
    tracker.observe("unrelated");
    await delay(10);
    assert.equal(pending.length, 2, "one coalesced query after request settles");
    pending[1]!.reject(new Error("temporary failure"));
    await delay(0);
    assert.equal(readings.at(-1)?.snapshot?.latestRequest.inputTokens, 2500);
    assert.equal(readings.at(-1)?.error, "temporary failure");
    tracker.observe("s");
    await delay(10);
    const next = { ...target, routeId: "p/new", modelId: "new", configurationRevision: "v2" };
    tracker.setTarget(next);
    assert.equal(readings.at(-1)?.targetKey, contextTargetKey(next));
    assert.equal(readings.at(-1)?.snapshot, undefined);
    pending[2]!.resolve(contextSnapshot());
    await delay(0);
    assert.equal(readings.at(-1)?.snapshot, undefined, "late success from old route is discarded");
    pending[3]!.reject(new Error("new route unavailable"));
    await delay(0);
    assert.equal(
      readings.at(-1)?.snapshot,
      undefined,
      "new route error must not resurrect old usage",
    );
    tracker.setTarget(target);
    const count = readings.length;
    tracker.dispose();
    pending[4]!.resolve(contextSnapshot());
    await delay(0);
    assert.equal(readings.length, count, "disposed tracker rejects in-flight completion");
  } finally {
    tracker.dispose();
  }
});
