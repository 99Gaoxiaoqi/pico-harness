import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GraphBoardView,
  graphBoardCards,
} from "../../apps/desktop/src/renderer/conversation/ConversationGraphBoard.js";
import { parseGraphDetail } from "../../apps/desktop/src/renderer/workbar-panels/WorkbarPanelHost.js";

test("Graph board joins current operator generation, formal completion, and child navigation", () => {
  const detail = parseGraphDetail({
    summary: {
      graphId: "g",
      epoch: 2,
      phase: "open",
      headRevision: 3,
      createdAt: 1,
      counts: { operators: 2, intents: 3, claims: 2, records: 1, resources: 0, wakes: 0 },
    },
    operators: [
      { operatorId: "a", generation: 2, role: "explore", profile: { profileId: "explore" } },
      { operatorId: "b", generation: 1, role: "explore", profile: {} },
    ],
    provisions: [
      { operatorId: "a", generation: 1, childSessionId: "old-child" },
      { operatorId: "a", generation: 2, childSessionId: "child-a" },
    ],
    intents: [
      {
        intentId: "old",
        operatorId: "a",
        operatorGeneration: 1,
        instruction: "旧任务",
        createdAtRevision: 1,
      },
      {
        intentId: "a-new",
        operatorId: "a",
        operatorGeneration: 2,
        instruction: "读取 A",
        createdAtRevision: 3,
      },
      {
        intentId: "b",
        operatorId: "b",
        operatorGeneration: 1,
        instruction: "读取 B",
        createdAtRevision: 2,
      },
    ],
    claims: [
      { claimId: "ca", intentId: "a-new", state: "executing", targetSessionId: "child-a" },
      { claimId: "cb", intentId: "b", state: "executing", targetSessionId: "child-b" },
    ],
    runtimeClaims: [
      { claimId: "ca", status: "completed" },
      { claimId: "cb", status: "waiting_permission" },
    ],
    outputs: [{ claimId: "ca", status: "success" }],
    records: [],
    diagnostics: [],
    wakes: [],
  });
  const cards = graphBoardCards(detail);
  assert.deepEqual(
    cards.map(({ sessionId, label, settled }) => ({ sessionId, label, settled })),
    [
      { sessionId: "child-a", label: "完成", settled: true },
      { sessionId: "child-b", label: "等待授权", settled: false },
    ],
  );
  Object.assign(globalThis, { React });
  const props = {
    detail,
    graphs: [detail.summary],
    loading: false,
    stopping: false,
    onSelect: () => undefined,
    onOpenSession: () => undefined,
    onStop: () => undefined,
    onRefresh: () => undefined,
    onDetails: () => undefined,
  };
  const html = renderToStaticMarkup(React.createElement(GraphBoardView, props));
  assert.match(html, /1\/2 已结束/u);
  assert.match(html, /停止 Graph/u);
  assert.match(html, /读取 A/u);
  assert.match(html, /等待授权/u);
  assert.equal((html.match(/>打开子任务</gu) ?? []).length, 2);
  assert.doesNotMatch(html, /旧任务|old-child/u);
  const history = renderToStaticMarkup(
    React.createElement(GraphBoardView, {
      ...props,
      graphs: [detail.summary, { ...detail.summary, graphId: "next", epoch: 3 }],
    }),
  );
  assert.doesNotMatch(history, /停止 Graph/u);
  assert.match(history, /Graph 周期/u);
  const empty = renderToStaticMarkup(
    React.createElement(GraphBoardView, {
      ...props,
      detail: { ...detail, operators: [], intents: [], claims: [] },
    }),
  );
  assert.equal(empty, "", "direct replies do not open an empty delegation board");
});
