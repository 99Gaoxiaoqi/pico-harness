import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBAR_MAX_WIDTH,
  WORKBAR_MIN_WIDTH,
  createWorkbarState,
  loadWorkbarState,
  parseWorkbarState,
  reduceWorkbarState,
  saveWorkbarState,
  serializeWorkbarState,
  type WorkbarStorage,
} from "../../apps/desktop/src/renderer/workbar/index.js";

test("Workbar closes the active tab back to the most recently selected tab", () => {
  let state = createWorkbarState();
  state = reduceWorkbarState(state, { type: "select", tabId: "review" });
  state = reduceWorkbarState(state, {
    type: "open",
    tab: { id: "tool-call-1", kind: "inspector", label: "Read file" },
  });

  assert.deepEqual(state.mruTabIds.slice(0, 3), ["tool-call-1", "review", "overview"]);

  state = reduceWorkbarState(state, { type: "close", tabId: "tool-call-1" });

  assert.equal(state.activeTabId, "review");
  assert.deepEqual(state.mruTabIds, ["review", "overview", "context"]);
});

test("Workbar supports stable reorder, collapse and a clamped width", () => {
  let state = createWorkbarState();
  state = reduceWorkbarState(state, { type: "reorder", tabId: "context", toIndex: 0 });
  state = reduceWorkbarState(state, { type: "setCollapsed", collapsed: true });
  state = reduceWorkbarState(state, { type: "setWidth", width: 100 });

  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["context", "overview", "review"],
  );
  assert.equal(state.collapsed, true);
  assert.equal(state.width, WORKBAR_MIN_WIDTH);

  state = reduceWorkbarState(state, { type: "setWidth", width: 900 });
  assert.equal(state.width, WORKBAR_MAX_WIDTH);

  const unchanged = reduceWorkbarState(state, { type: "setWidth", width: Number.NaN });
  assert.equal(unchanged, state);
});

test("Workbar persistence is versioned and excludes transient inspector tabs", () => {
  let state = createWorkbarState({ collapsed: true, width: 510 });
  state = reduceWorkbarState(state, {
    type: "open",
    tab: { id: "resource-secret", kind: "inspector", label: "Dynamic resource secret" },
  });
  const serialized = serializeWorkbarState(state);
  const payload: unknown = JSON.parse(serialized);

  assert.deepEqual(payload, {
    version: 1,
    layout: { collapsed: true, width: 510 },
    tabs: [
      { id: "overview", kind: "overview", label: "概览" },
      { id: "review", kind: "review", label: "变更" },
      { id: "context", kind: "context", label: "上下文" },
    ],
    activeTabId: "overview",
    mruTabIds: ["overview", "review", "context"],
  });
  assert.equal(serialized.includes("resource-secret"), false);
  assert.equal(serialized.includes("Dynamic resource secret"), false);

  const restored = parseWorkbarState(serialized);
  assert.equal(restored.activeTabId, "overview");
  assert.equal(restored.collapsed, true);
  assert.equal(restored.width, 510);
});

test("Workbar persistence fails safe for corrupt, unknown and unavailable storage", () => {
  const fallback = createWorkbarState({ width: 444 });

  assert.equal(parseWorkbarState("not-json", fallback), fallback);
  assert.equal(parseWorkbarState('{"version":2}', fallback), fallback);
  assert.equal(
    parseWorkbarState(
      JSON.stringify({
        version: 1,
        layout: { collapsed: false, width: 400 },
        tabs: [{ id: "unexpected", kind: "inspector", label: "Should not restore" }],
        activeTabId: "unexpected",
        mruTabIds: ["unexpected"],
      }),
      fallback,
    ),
    fallback,
  );

  const throwingStorage: WorkbarStorage = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("storage unavailable");
    },
  };
  assert.equal(loadWorkbarState(throwingStorage, fallback), fallback);
  assert.equal(saveWorkbarState(throwingStorage, fallback), false);
});
