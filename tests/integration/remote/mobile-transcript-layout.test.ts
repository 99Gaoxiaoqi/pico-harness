import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeConversationItem,
  type RuntimeTranscriptItemRecord,
} from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import {
  rowIndexForItem,
  transcriptRows,
  type TranscriptRow,
} from "../../../apps/mobile/src/conversation/transcriptRows.js";
import { mobileComponent, mobileTags } from "../../fixtures/mobile-component-harness.js";

type Node = { type: unknown; props: Record<string, unknown> };
type ScrollEvent = {
  nativeEvent: {
    contentOffset: { x: number; y: number };
    layoutMeasurement: { width: number; height: number };
    contentSize: { width: number; height: number };
  };
};
type Viewport = {
  listRef: {
    current: {
      scrollToEnd(): void;
      scrollToIndex(target: { index: number; viewOffset: number }): void;
    } | null;
  };
  Cell(props: { item: TranscriptRow; children: null; style: Record<string, unknown> }): Node;
  showLatest: boolean;
  beforeRowResize(): void;
  jumpToItem(itemId: string): void;
  loadOlder(load: () => Promise<void>): Promise<void>;
  onScroll(event: ScrollEvent): void;
  onScrollBeginDrag(): void;
  onScrollEndDrag(event: ScrollEvent): void;
  onViewableItemsChanged(
    items: Array<{ key: string; item: TranscriptRow; index: number; isViewable: boolean }>,
  ): void;
  onContentSizeChange(width: number, height: number): void;
};

function record(item: RuntimeConversationItem, sequence: number): RuntimeTranscriptItemRecord {
  return { itemId: item.id, itemRevision: 1, positionSequence: sequence, positionOrdinal: 0, item };
}
function thinking(
  id: string,
  sequence: number,
  identity: { runId?: string; turnId?: string } = { runId: "run", turnId: "turn" },
) {
  return record({ id, kind: "thinking", content: id, ...identity }, sequence);
}
function tool(id: string, sequence: number, status: "running" | "success" | "error" = "success") {
  const common = {
    id,
    kind: "tool" as const,
    name: "read_file",
    args: "{}",
    runId: "run",
    turnId: "turn",
    data: { toolCallId: id, providerCallId: id, entryId: id },
  };
  if (status === "running") return record({ ...common, status }, sequence);
  return record(
    {
      ...common,
      status,
      result: {
        version: 1,
        toolCallId: id,
        toolName: common.name,
        status: status === "success" ? "succeeded" : "failed",
        rawSizeBytes: 0,
        sha256: "a".repeat(64),
        deliveryTruncated: false,
        projection: { version: 1, mode: "full", text: id, strategy: "text", truncated: false },
      },
    },
    sequence,
  );
}
function view(records: readonly RuntimeTranscriptItemRecord[]): TranscriptReplicaView {
  return {
    phase: "ready",
    generation: 1,
    sessionId: "session",
    watermark: {
      historyEpoch: "history",
      projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
      throughSequence: 100,
    },
    records,
    activeOverlay: [],
    queuedInputs: [],
  };
}
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== "object") return [];
  const node = tree as Node;
  const children = node.props?.children;
  return [node, ...(Array.isArray(children) ? children.flat(Infinity).flatMap(nodes) : [])];
}

test("手机过程折叠后展开和加载更早记录保留阅读偏移，待处理跳转按展示行定位", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let records = [
    thinking("thinking", 10),
    tool("live-tool", 11, "running"),
    tool("done-tool", 12),
    record({ id: "answer", kind: "assistantMessage", content: "正文保持独立" }, 13),
    record({ id: "approval", kind: "approval", title: "需要批准", state: "waiting", data: {} }, 14),
    record({ id: "prompt", kind: "prompt", title: "需要回答", state: "waiting", data: {} }, 15),
  ];
  let rows = transcriptRows(records);
  assert.deepEqual(
    rows.map((row) => row.records.length),
    [3, 1, 1, 1],
  );
  const screen = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/useTranscriptViewport.tsx", import.meta.url),
    {
      "react-native": mobileTags(["FlatList", "View"]),
      "./transcriptRows": { rowIndexForItem },
    },
  );
  t.after(() => screen.dispose());
  let viewport = screen.render<Viewport>(
    "useTranscriptViewport",
    view(records),
    true,
    true,
    0,
    rows,
  );
  const render = () => {
    viewport = screen.render<Viewport>("useTranscriptViewport", view(records), true, true, 0, rows);
    return viewport;
  };
  let height = 760;
  let scrollY = 0;
  let positions = new Map([
    ["thinking", 100],
    ["answer", 260],
    ["approval", 340],
    ["prompt", 420],
  ]);
  const scrollEvent = (y: number) => ({
    nativeEvent: {
      contentOffset: { x: 0, y },
      layoutMeasurement: { width: 320, height: 160 },
      contentSize: { width: 320, height },
    },
  });
  const scroll = (y: number) => {
    scrollY = y;
    viewport.onScroll(scrollEvent(y));
  };
  const jumps: Array<{ index: number; viewOffset: number }> = [];
  let followed = 0;
  viewport.listRef.current = {
    scrollToEnd() {
      followed++;
      scroll(height - 160);
    },
    scrollToIndex(target: { index: number; viewOffset: number }) {
      jumps.push(target);
      scroll(positions.get(rows[target.index]!.key)! - target.viewOffset);
    },
  };
  const layoutRows = () => {
    for (const row of rows) {
      const cell = viewport.Cell({ item: row, children: null, style: {} });
      (cell.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { y: positions.get(row.key) } },
      });
    }
  };
  layoutRows();
  t.mock.timers.tick(1);
  assert.equal(followed, 1);
  viewport.onScrollBeginDrag();
  scroll(124);
  viewport.onViewableItemsChanged([
    { key: rows[0]!.key, item: rows[0]!, index: 0, isViewable: true },
  ]);
  viewport.onScrollEndDrag(scrollEvent(124));
  render();
  assert.equal(viewport.showLatest, true);

  let resizes = 0;
  const group = mobileComponent(
    new URL("../../../apps/mobile/src/conversation/TranscriptItem.tsx", import.meta.url),
    {
      "react-native": {
        ...mobileTags(["Pressable", "Text", "View"]),
        StyleSheet: { create: (value: unknown) => value },
      },
      "../store": { usePico: () => ({}) },
      "../ui": { ...mobileTags(["Button", "Card", "Detail", "Field", "Label"]), s: {}, color: {} },
      "../MessageMarkdown": mobileTags(["MessageMarkdown"]),
      "../markdown": {},
      "../MessageMedia": mobileTags(["MessageMedia"]),
      "../media": {},
    },
  );
  t.after(() => group.dispose());
  const renderGroup = () =>
    group.render("ProcessGroup", {
      records: rows[rowIndexForItem(rows, "thinking")]!.records,
      sessionId: "session",
      onResize() {
        resizes++;
        viewport.beforeRowResize();
      },
    });
  const groupItems = (tree: Node) => nodes(tree).filter((node) => node.props.item);
  assert.equal(groupItems(renderGroup()).length, 0, "默认折叠，不挂载过程详情");
  assert.equal(
    (group.nodes("Pressable")[0]!.props.accessibilityState as { expanded: boolean }).expanded,
    false,
  );
  (group.nodes("Pressable")[0]!.props.onPress as () => void)();
  assert.equal(resizes, 1);
  assert.deepEqual(
    groupItems(renderGroup()).map((node) => (node.props.item as RuntimeConversationItem).id),
    ["thinking", "live-tool", "done-tool"],
  );
  height += 200;
  positions = new Map([
    ["thinking", 100],
    ["answer", 460],
    ["approval", 540],
    ["prompt", 620],
  ]);
  layoutRows();
  scroll(124);
  viewport.onContentSizeChange(320, height);
  t.mock.timers.tick(81);
  assert.equal(jumps.at(-1)!.viewOffset, -24);
  assert.equal(positions.get("thinking")! - scrollY, -24);
  assert.equal(followed, 1, "展开过程后继续停留在阅读位置");

  records = records.map((item) =>
    item.itemId === "live-tool" ? { ...tool("live-tool", 11), itemRevision: 2 } : item,
  );
  rows = transcriptRows(records, rows);
  render();
  const liveItem = groupItems(renderGroup()).find(
    (node) => (node.props.item as RuntimeConversationItem).id === "live-tool",
  )!.props.item as RuntimeConversationItem;
  assert.equal("status" in liveItem && liveItem.status, "success", "展开状态中接收工具结束更新");
  const prior = rows;
  await viewport.loadOlder(async () => {
    records = [
      record({ id: "old-user", kind: "userMessage", content: "较早输入" }, 1),
      thinking("old-thinking", 8),
      tool("old-tool", 9),
      ...records,
    ];
    rows = transcriptRows(records, prior);
    positions = new Map([
      ["old-user", 0],
      ["old-thinking", 80],
      ["thinking", 300],
      ["answer", 660],
      ["approval", 740],
      ["prompt", 820],
    ]);
    height += 200;
    render();
    layoutRows();
    viewport.onContentSizeChange(320, height);
  });
  t.mock.timers.tick(81);
  assert.equal(rows[2]!.key, prior[0]!.key, "分页保留原过程组起点");
  assert.deepEqual(
    rows[2]!.records.map((item) => item.itemId),
    ["thinking", "live-tool", "done-tool"],
  );
  assert.equal(jumps.at(-1)!.index, 2);
  assert.equal(jumps.at(-1)!.viewOffset, -24);
  assert.equal(positions.get("thinking")! - scrollY, -24);
  assert.equal(followed, 1);

  viewport.jumpToItem("approval");
  assert.equal(jumps.at(-1)!.index, 4, "原记录 index 为 7，展示行 index 为 4");
  assert.equal(jumps.at(-1)!.viewOffset, 0);
  t.mock.timers.tick(81);
  viewport.jumpToItem("done-tool");
  assert.equal(jumps.at(-1)!.index, 2, "过程成员跳转到所属展示行");
  t.mock.timers.tick(81);
  (group.nodes("Pressable")[0]!.props.onPress as () => void)();
  assert.equal(groupItems(renderGroup()).length, 0);
  assert.equal(resizes, 2, "收起前也保存阅读位置");
  height -= 200;
  positions = new Map([
    ["old-user", 0],
    ["old-thinking", 80],
    ["thinking", 300],
    ["answer", 460],
    ["approval", 540],
    ["prompt", 620],
  ]);
  layoutRows();
  viewport.onContentSizeChange(320, height);
  t.mock.timers.tick(81);

  viewport.onScrollBeginDrag();
  scroll(487);
  viewport.onViewableItemsChanged([{ key: "answer", item: rows[3]!, index: 3, isViewable: true }]);
  viewport.onScrollEndDrag(scrollEvent(487));
  records = records.map((item) =>
    item.itemId === "live-tool" ? { ...tool("live-tool", 11, "error"), itemRevision: 3 } : item,
  );
  rows = transcriptRows(records, rows);
  positions = new Map([
    ["old-user", 0],
    ["old-thinking", 80],
    ["thinking", 300],
    ["live-tool", 350],
    ["done-tool", 400],
    ["answer", 520],
    ["approval", 600],
    ["prompt", 680],
  ]);
  height += 60;
  render();
  layoutRows();
  viewport.onContentSizeChange(320, height);
  t.mock.timers.tick(81);
  assert.equal(
    rows[rowIndexForItem(rows, "live-tool")]!.records.length,
    1,
    "错误工具从过程组中独立展示",
  );
  assert.equal(jumps.at(-1)!.index, 5, "组拆分后正文展示行 index 为 5，原记录 index 为 6");
  assert.equal(jumps.at(-1)!.viewOffset, -27);
  assert.equal(positions.get("answer")! - scrollY, -27);
  assert.equal(followed, 1, "错误工具导致组拆分时保留正在阅读的正文");
});

test("手机仅聚合同一次运行同一轮的连续过程，错误、交互和缺失身份保持独立", () => {
  const records = [
    thinking("first", 1),
    tool("success", 2),
    tool("error", 3, "error"),
    thinking("after-error", 4),
    record({ id: "approval", kind: "approval", title: "批准", state: "waiting", data: {} }, 5),
    thinking("after-approval", 6),
    record({ id: "prompt", kind: "prompt", title: "回答", state: "waiting", data: {} }, 7),
    thinking("missing-run", 8, { turnId: "turn" }),
    thinking("missing-turn", 9, { runId: "run" }),
    thinking("blank-turn", 10, { runId: "run", turnId: " " }),
    thinking("other-run", 11, { runId: "other", turnId: "turn" }),
    thinking("other-turn", 12, { runId: "other", turnId: "another" }),
    thinking("same-turn", 13, { runId: "other", turnId: "another" }),
    record(
      {
        id: "answer",
        kind: "assistantMessage",
        content: "正文",
        runId: "other",
        turnId: "another",
      },
      14,
    ),
    thinking("after-answer", 15, { runId: "other", turnId: "another" }),
  ];
  assert.deepEqual(
    transcriptRows(records).map((row: TranscriptRow) => row.records.map((item) => item.itemId)),
    [
      ["first", "success"],
      ["error"],
      ["after-error"],
      ["approval"],
      ["after-approval"],
      ["prompt"],
      ["missing-run"],
      ["missing-turn"],
      ["blank-turn"],
      ["other-run"],
      ["other-turn", "same-turn"],
      ["answer"],
      ["after-answer"],
    ],
  );
});
