import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBAR_MAX_WIDTH,
  WORKBAR_MIN_WIDTH,
  WORKBAR_TOOL_REGISTRY,
  createWorkbarState,
  createWorkbarToolTab,
  loadWorkbarState,
  isWorkbarPanelActive,
  parseWorkbarState,
  reduceWorkbarState,
  resolveWorkbarShortcut,
  saveWorkbarState,
  serializeWorkbarState,
  type WorkbarStorage,
} from "../../../apps/desktop/src/renderer/workbar/index.js";

const shortcut = (
  key: string,
  modifiers: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) =>
  resolveWorkbarShortcut({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  });

test("Workbar starts collapsed and exposes the eight tools in the intended order", () => {
  const state = createWorkbarState();

  assert.deepEqual(Object.keys(state).toSorted(), [
    "activeTabId",
    "collapsed",
    "launcherOpen",
    "mruTabIds",
    "tabs",
    "width",
  ]);
  assert.deepEqual(state.tabs, []);
  assert.equal(state.collapsed, true);
  assert.deepEqual(
    WORKBAR_TOOL_REGISTRY.map((tool) => tool.kind),
    ["side-chat", "review", "terminal", "browser", "files", "tasks", "inspector", "graph"],
  );
});

test("Workbar Registry resolves the configured global shortcuts", () => {
  assert.equal(shortcut("g", { ctrlKey: true, shiftKey: true }), "review");
  assert.equal(shortcut("`", { ctrlKey: true }), "terminal");
  assert.equal(shortcut("t", { metaKey: true }), "browser");
  assert.equal(shortcut("p", { ctrlKey: true }), "files");
  assert.equal(shortcut("s", { metaKey: true, altKey: true }), "side-chat");
  assert.equal(shortcut("p", { ctrlKey: true, shiftKey: true }), undefined);
});

test("Graph details can be explicitly opened in the right Dock", () => {
  const state = reduceWorkbarState(createWorkbarState(), {
    type: "open",
    tab: createWorkbarToolTab("graph"),
  });

  assert.equal(state.collapsed, false);
  assert.equal(state.activeTabId, "graph");
  assert.deepEqual(state.tabs, [createWorkbarToolTab("graph")]);
});

test("Workbar exposes a strict active gate for mounted domain panels", () => {
  let state = createWorkbarState({
    collapsed: false,
    tabs: [createWorkbarToolTab("review")],
  });
  assert.equal(isWorkbarPanelActive(state, "review", { sessionBound: true }), true);
  assert.equal(
    isWorkbarPanelActive(state, "review", {
      sessionBound: true,
      shellObscured: true,
    }),
    false,
  );
  state = reduceWorkbarState(state, {
    type: "setLauncherOpen",
    open: true,
  });
  assert.equal(isWorkbarPanelActive(state, "review", { sessionBound: true }), false);
});

test("Workbar opens every tool in one panel and restores the selection after collapse", () => {
  let state = createWorkbarState();
  for (const tool of WORKBAR_TOOL_REGISTRY) {
    state = reduceWorkbarState(state, { type: "open", tab: createWorkbarToolTab(tool.kind) });
  }
  state = reduceWorkbarState(state, { type: "open", tab: createWorkbarToolTab("terminal") });
  assert.equal(state.tabs.length, WORKBAR_TOOL_REGISTRY.length);
  assert.equal(state.activeTabId, "terminal");
  state = reduceWorkbarState(state, { type: "setCollapsed", collapsed: true });
  assert.equal(isWorkbarPanelActive(state, "terminal", { sessionBound: true }), false);
  state = reduceWorkbarState(state, { type: "setCollapsed", collapsed: false });
  assert.equal(isWorkbarPanelActive(state, "terminal", { sessionBound: true }), true);
  assert.equal(state.tabs.length, WORKBAR_TOOL_REGISTRY.length);
});

test("Workbar closes an active tab back to the MRU tab", () => {
  let state = createWorkbarState({
    collapsed: false,
    tabs: [createWorkbarToolTab("review"), createWorkbarToolTab("tasks")],
  });
  state = reduceWorkbarState(state, { type: "select", tabId: "review" });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    tab: { id: "trace:tool-1", kind: "inspector", label: "Read file" },
  });
  assert.deepEqual(state.mruTabIds.slice(0, 3), ["trace:tool-1", "review", "tasks"]);

  state = reduceWorkbarState(state, { type: "close", tabId: "trace:tool-1" });
  assert.equal(state.activeTabId, "review");
});

test("Workbar replaces one unpinned preview and preserves pinned previews", () => {
  let state = createWorkbarState();
  state = reduceWorkbarState(state, {
    type: "openPreview",
    tab: { id: "trace:one", kind: "inspector", label: "One" },
  });
  state = reduceWorkbarState(state, { type: "pinPreview", tabId: "trace:one" });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    tab: { id: "trace:two", kind: "inspector", label: "Two" },
  });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    tab: { id: "trace:three", kind: "inspector", label: "Three" },
  });

  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["trace:one", "trace:three"],
  );
  assert.equal(state.tabs[0]?.pinned, true);
  assert.equal(state.tabs[1]?.preview, true);
});

test("Workbar supports reorder, context-menu close operations and bounded width", () => {
  let state = createWorkbarState({
    collapsed: false,
    tabs: [
      { id: "terminal:1", kind: "terminal", label: "Terminal 1" },
      { id: "terminal:2", kind: "terminal", label: "Terminal 2" },
      { id: "terminal:3", kind: "terminal", label: "Terminal 3" },
    ],
  });
  state = reduceWorkbarState(state, { type: "reorder", tabId: "terminal:3", toIndex: 0 });
  state = reduceWorkbarState(state, { type: "closeRight", tabId: "terminal:1" });
  state = reduceWorkbarState(state, { type: "setWidth", width: 100 });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["terminal:3", "terminal:1"],
  );
  assert.equal(state.width, WORKBAR_MIN_WIDTH);
  state = reduceWorkbarState(state, { type: "setWidth", width: WORKBAR_MAX_WIDTH + 100 });
  assert.equal(state.width, WORKBAR_MAX_WIDTH);
  state = reduceWorkbarState(state, { type: "closeOthers", tabId: "terminal:1" });
  assert.deepEqual(
    state.tabs.map((tab) => tab.id),
    ["terminal:1"],
  );
});

test("Workbar v3 persistence keeps layout and only canonical restart-safe static tools", () => {
  let state = createWorkbarState({
    width: 510,
    collapsed: false,
    tabs: [createWorkbarToolTab("review"), createWorkbarToolTab("files")],
  });
  state = reduceWorkbarState(state, {
    type: "open",
    tab: { id: "terminal:1", kind: "terminal", label: "Terminal 1" },
  });
  state = reduceWorkbarState(state, {
    type: "open",
    tab: { id: "side-chat:1", kind: "side-chat", label: "Side chat" },
  });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    tab: { id: "trace:secret", kind: "inspector", label: "Secret detail" },
  });

  const serialized = serializeWorkbarState(state);
  const payload = JSON.parse(serialized) as {
    version: number;
    tabs: unknown[];
  };
  assert.equal(payload.version, 3);
  assert.deepEqual(payload.tabs, [
    { id: "review", kind: "review", label: "变更" },
    { id: "files", kind: "files", label: "生成文件" },
  ]);
  assert.equal(serialized.includes("trace:secret"), false);
  assert.equal(serialized.includes("terminal:1"), false);
  assert.equal(serialized.includes("side-chat:1"), false);

  const restored = parseWorkbarState(serialized);
  assert.equal(restored.width, 510);
  assert.deepEqual(
    restored.tabs.map((tab) => tab.id),
    ["review", "files"],
  );
  assert.equal(restored.launcherOpen, false);
});

test("Workbar rejects unsupported layout versions without retaining migration code", () => {
  const fallback = createWorkbarState({ width: 512 });
  for (const version of [1, 2, 4]) {
    assert.equal(parseWorkbarState(JSON.stringify({ version }), fallback), fallback);
  }
});

test("Workbar persistence fails safe for corrupt state and unavailable storage", () => {
  const fallback = createWorkbarState({ width: 444 });

  assert.equal(parseWorkbarState("not-json", fallback), fallback);
  assert.equal(parseWorkbarState('{"version":3}', fallback), fallback);

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
