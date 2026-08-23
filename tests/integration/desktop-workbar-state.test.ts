import assert from "node:assert/strict";
import test from "node:test";

import {
  WORKBAR_MAX_HEIGHT,
  WORKBAR_MAX_WIDTH,
  WORKBAR_MIN_HEIGHT,
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
} from "../../apps/desktop/src/renderer/workbar/index.js";

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

test("Workbar v2 starts collapsed and exposes the seven tools in the intended order", () => {
  const state = createWorkbarState();

  assert.deepEqual(state.docks.right.tabs, []);
  assert.deepEqual(state.docks.bottom.tabs, []);
  assert.equal(state.docks.right.collapsed, true);
  assert.equal(state.docks.bottom.collapsed, true);
  assert.deepEqual(
    WORKBAR_TOOL_REGISTRY.map((tool) => tool.kind),
    ["side-chat", "review", "terminal", "browser", "files", "tasks", "inspector"],
  );
});

test("Workbar Registry resolves the Maka-compatible global shortcuts", () => {
  assert.equal(shortcut("g", { ctrlKey: true, shiftKey: true }), "review");
  assert.equal(shortcut("`", { ctrlKey: true }), "terminal");
  assert.equal(shortcut("t", { metaKey: true }), "browser");
  assert.equal(shortcut("p", { ctrlKey: true }), "files");
  assert.equal(shortcut("s", { metaKey: true, altKey: true }), "side-chat");
  assert.equal(shortcut("p", { ctrlKey: true, shiftKey: true }), undefined);
});

test("Workbar exposes a strict active gate for mounted domain panels", () => {
  let state = createWorkbarState({
    docks: { right: { collapsed: false, tabs: [createWorkbarToolTab("review")] } },
  });
  assert.equal(isWorkbarPanelActive(state, "right", "review", { sessionBound: true }), true);
  assert.equal(
    isWorkbarPanelActive(state, "right", "review", {
      sessionBound: true,
      shellObscured: true,
    }),
    false,
  );
  state = reduceWorkbarState(state, {
    type: "setLauncherOpen",
    dock: "right",
    open: true,
  });
  assert.equal(isWorkbarPanelActive(state, "right", "review", { sessionBound: true }), false);
});

test("Workbar keeps tab ids globally unique while moving between Docks", () => {
  let state = createWorkbarState();
  state = reduceWorkbarState(state, {
    type: "open",
    dock: "right",
    tab: createWorkbarToolTab("review"),
  });
  state = reduceWorkbarState(state, {
    type: "open",
    dock: "bottom",
    tab: createWorkbarToolTab("review"),
  });

  assert.deepEqual(state.docks.right.tabs, []);
  assert.deepEqual(
    state.docks.bottom.tabs.map((tab) => tab.id),
    ["review"],
  );

  state = reduceWorkbarState(state, { type: "moveDock", tabId: "review", toDock: "right" });
  assert.deepEqual(
    state.docks.right.tabs.map((tab) => tab.id),
    ["review"],
  );
  assert.deepEqual(state.docks.bottom.tabs, []);
  assert.equal(state.docks.bottom.collapsed, true);
});

test("Workbar closes an active tab back to the Dock-local MRU tab", () => {
  let state = createWorkbarState({
    docks: {
      right: {
        collapsed: false,
        tabs: [createWorkbarToolTab("review"), createWorkbarToolTab("tasks")],
      },
    },
  });
  state = reduceWorkbarState(state, { type: "select", dock: "right", tabId: "review" });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    dock: "right",
    tab: { id: "trace:tool-1", kind: "inspector", label: "Read file" },
  });
  assert.deepEqual(state.docks.right.mruTabIds.slice(0, 3), ["trace:tool-1", "review", "tasks"]);

  state = reduceWorkbarState(state, { type: "close", tabId: "trace:tool-1" });
  assert.equal(state.docks.right.activeTabId, "review");
});

test("Workbar replaces one unpinned preview per Dock and preserves pinned previews", () => {
  let state = createWorkbarState();
  state = reduceWorkbarState(state, {
    type: "openPreview",
    dock: "right",
    tab: { id: "trace:one", kind: "inspector", label: "One" },
  });
  state = reduceWorkbarState(state, { type: "pinPreview", tabId: "trace:one" });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    dock: "right",
    tab: { id: "trace:two", kind: "inspector", label: "Two" },
  });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    dock: "right",
    tab: { id: "trace:three", kind: "inspector", label: "Three" },
  });

  assert.deepEqual(
    state.docks.right.tabs.map((tab) => tab.id),
    ["trace:one", "trace:three"],
  );
  assert.equal(state.docks.right.tabs[0]?.pinned, true);
  assert.equal(state.docks.right.tabs[1]?.preview, true);
});

test("Workbar supports reorder, context-menu close operations and bounded Dock sizes", () => {
  let state = createWorkbarState({
    docks: {
      bottom: {
        collapsed: false,
        tabs: [
          { id: "terminal:1", kind: "terminal", label: "Terminal 1" },
          { id: "terminal:2", kind: "terminal", label: "Terminal 2" },
          { id: "terminal:3", kind: "terminal", label: "Terminal 3" },
        ],
      },
    },
  });
  state = reduceWorkbarState(state, {
    type: "reorder",
    dock: "bottom",
    tabId: "terminal:3",
    toIndex: 0,
  });
  state = reduceWorkbarState(state, { type: "closeRight", tabId: "terminal:1" });
  state = reduceWorkbarState(state, { type: "setWidth", width: 100 });
  state = reduceWorkbarState(state, { type: "setHeight", height: 900 });

  assert.deepEqual(
    state.docks.bottom.tabs.map((tab) => tab.id),
    ["terminal:3", "terminal:1"],
  );
  assert.equal(state.rightWidth, WORKBAR_MIN_WIDTH);
  assert.equal(state.bottomHeight, WORKBAR_MAX_HEIGHT);

  state = reduceWorkbarState(state, { type: "setWidth", width: 900 });
  state = reduceWorkbarState(state, { type: "setHeight", height: 100 });
  assert.equal(state.rightWidth, WORKBAR_MAX_WIDTH);
  assert.equal(state.bottomHeight, WORKBAR_MIN_HEIGHT);
});

test("Workbar v2 persistence keeps layouts and only canonical restart-safe static tools", () => {
  let state = createWorkbarState({
    focusedDock: "bottom",
    rightWidth: 510,
    bottomHeight: 410,
    docks: {
      right: { collapsed: false, tabs: [createWorkbarToolTab("review")] },
      bottom: { collapsed: false, tabs: [createWorkbarToolTab("files")] },
    },
  });
  state = reduceWorkbarState(state, {
    type: "open",
    dock: "bottom",
    tab: { id: "terminal:1", kind: "terminal", label: "Terminal 1" },
  });
  state = reduceWorkbarState(state, {
    type: "open",
    dock: "right",
    tab: { id: "side-chat:1", kind: "side-chat", label: "Side chat" },
  });
  state = reduceWorkbarState(state, {
    type: "openPreview",
    dock: "right",
    tab: { id: "trace:secret", kind: "inspector", label: "Secret detail" },
  });

  const serialized = serializeWorkbarState(state);
  const payload = JSON.parse(serialized) as {
    version: number;
    docks: { right: { tabs: unknown[] }; bottom: { tabs: unknown[] } };
  };
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.docks.right.tabs, [{ id: "review", kind: "review", label: "变更" }]);
  assert.deepEqual(payload.docks.bottom.tabs, [{ id: "files", kind: "files", label: "生成文件" }]);
  assert.equal(serialized.includes("trace:secret"), false);
  assert.equal(serialized.includes("terminal:1"), false);
  assert.equal(serialized.includes("side-chat:1"), false);

  const restored = parseWorkbarState(serialized);
  assert.equal(restored.rightWidth, 510);
  assert.equal(restored.bottomHeight, 410);
  assert.equal(restored.focusedDock, "right");
  assert.deepEqual(
    restored.docks.right.tabs.map((tab) => tab.id),
    ["review"],
  );
  assert.deepEqual(
    restored.docks.bottom.tabs.map((tab) => tab.id),
    ["files"],
  );
});

test("Workbar migrates v1 overview and context tabs into one Inspector tab", () => {
  const restored = parseWorkbarState(
    JSON.stringify({
      version: 1,
      layout: { collapsed: false, width: 444 },
      tabs: [
        { id: "overview", kind: "overview", label: "概览" },
        { id: "review", kind: "review", label: "变更" },
        { id: "context", kind: "context", label: "上下文" },
      ],
      activeTabId: "context",
      mruTabIds: ["context", "review", "overview"],
    }),
  );

  assert.deepEqual(restored.docks.right.tabs, [
    { id: "inspector", kind: "inspector", label: "追踪" },
    { id: "review", kind: "review", label: "变更" },
  ]);
  assert.equal(restored.docks.right.activeTabId, "inspector");
  assert.deepEqual(restored.docks.right.mruTabIds, ["inspector", "review"]);
  assert.equal(restored.rightWidth, 444);
  assert.equal(restored.docks.bottom.collapsed, true);
});

test("Workbar persistence fails safe for corrupt state and unavailable storage", () => {
  const fallback = createWorkbarState({ rightWidth: 444 });

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
