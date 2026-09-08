import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { LoadToolsTool } from "../../../src/tools/load-tools.js";
import { ToolDisclosure } from "../../../src/tools/tool-disclosure.js";
import { PICO_TOOL_GROUPS } from "../../../src/tools/tool-surface.js";
import type {
  ConversationItemView,
  SubagentItemView,
  ToolItemView,
} from "../../../apps/desktop/src/renderer/conversation/types.js";

Object.assign(globalThis, { React });

const child: SubagentItemView = {
  id: "subagent:reader",
  kind: "subagent",
  name: "代码审查",
  title: "检查实现",
  detail: "正在核对状态流转与边界条件",
  state: "active",
  childSessionId: "reader-session",
  readOnly: true,
  durationMs: 1250,
  toolCallId: "spawn-reader",
};

function render(items: readonly ConversationItemView[], navigable = true) {
  return renderToStaticMarkup(
    React.createElement(ConversationTranscript, {
      items,
      ...(navigable ? { onOpenItem: () => undefined } : {}),
    }),
  );
}

function spawn(id: string, title: string): ToolItemView {
  return { id, kind: "tool", toolName: "agent_spawn", title, state: "done" };
}

test("真实工具组加载结果显示协作卡与折叠技术详情，失败和不完整记录不误报启用", async () => {
  const loader = new LoadToolsTool(PICO_TOOL_GROUPS, new ToolDisclosure(), () => ["agent_spawn"]);
  const output = await loader.execute(JSON.stringify({ group: "delegation" }));
  const activation: ToolItemView = {
    id: "load-agents",
    kind: "tool",
    toolName: "load_tools",
    title: "load_tools",
    state: "done",
    output,
  };
  const markup = render([activation, child]);
  assert.match(markup, /子智能体协作已启用/u);
  assert.match(markup, /已加载 1 项协作工具/u);
  assert.match(markup, /启动子任务后，点击子 Agent 名称可查看运行记录/u);
  assert.match(
    markup,
    /<details class="conversation-agent-capability__details"><summary>技术详情<\/summary>/u,
  );
  assert.match(markup, /<code>agent_spawn<\/code>/u);
  assert.match(markup, /查看加载记录/u);
  assert.match(markup, /查看代码审查的会话/u);
  assert.doesNotMatch(markup, /<code>spawn_subagent<\/code>/u);
  for (const invalid of [
    { ...activation, state: "failed" as const },
    { ...activation, state: "active" as const },
    { ...activation, output: output.replace("1 个工具", "2 个工具") },
    { ...activation, toolName: "agent_spawn" },
  ]) {
    const fallback = render([invalid]);
    assert.doesNotMatch(fallback, /子智能体协作已启用/u);
    assert.match(fallback, /conversation-tool-record/u);
  }
});

test("子代理以单个原生按钮展示摘要、状态、只读与耗时，仅真实会话提供入口", () => {
  const markup = render([child]);
  assert.match(markup, /<button type="button" class="conversation-subagent-row"/u);
  assert.match(markup, /aria-label="查看代码审查的会话"/u);
  assert.match(markup, /title="正在核对状态流转与边界条件"/u);
  assert.match(markup, /data-state="active"/u);
  assert.match(markup, /运行中 · 只读 · 1\.3s/u);
  assert.match(markup, /conversation-subagent-row__dot/u);
  assert.match(markup, /data-child="true">子智能体/u);
  assert.match(markup, /conversation-subagent-row__chevron/u);
  assert.match(markup, /conversation-subagent-row__action">查看运行/u);
  assert.doesNotMatch(markup, /disabled=|conversation-inline-card|<p\b|<header\b/u);
  assert.equal([...markup.matchAll(/<button\b/gu)].length, 1);
  for (const assistantLabel of ["主智能体 · Pico", "子智能体 · Local Read"]) {
    const response = renderToStaticMarkup(
      React.createElement(ConversationTranscript, {
        assistantLabel,
        items: [{ id: "reply", kind: "assistantMessage", text: "已完成" }],
      }),
    );
    assert.ok(response.includes(`<h3 class="conversation-message__author">${assistantLabel}</h3>`));
  }

  const { detail: _detail, ...withoutDetail } = child;
  const completed = render([{ ...withoutDetail, state: "done", durationMs: 0 }]);
  assert.match(completed, /title="检查实现"/u);
  assert.match(completed, /已完成 · 只读 · 0\.0s/u);

  const { childSessionId: _childSessionId, ...withoutSession } = child;
  for (const unavailable of [render([withoutSession]), render([child], false)]) {
    assert.match(unavailable, /disabled=""/u);
    assert.doesNotMatch(
      unavailable,
      /aria-label="查看|conversation-subagent-row__chevron|查看运行/u,
    );
  }
});

test("仅同轮次且调用标识明确匹配时合并 agent_spawn；历史缺少元数据及无关工具保持可见", () => {
  const { toolCallId: _toolCallId, ...legacyChild } = child;
  const envelopeTool: ToolItemView = {
    ...spawn("arbitrary-entry", "隐藏的结果关联启动"),
    result: {
      version: 1,
      toolCallId: "spawn-envelope",
      toolName: "agent_spawn",
      status: "succeeded",
      rawSizeBytes: 0,
      sha256: "0".repeat(64),
      deliveryTruncated: false,
      projection: {
        version: 1,
        mode: "full",
        text: "已创建",
        strategy: "full",
        truncated: false,
      },
    },
  };
  const markup = render([
    { id: "turn-one", kind: "userMessage", text: "先前任务" },
    spawn("tool:spawn-reader", "保留的先前轮次启动"),
    { id: "turn-two", kind: "userMessage", text: "检查项目" },
    spawn("tool:spawn-reader", "隐藏的稳定标识启动"),
    child,
    { ...spawn("tool:live:run:turn:spawn-reader", "隐藏的实时启动"), toolCallId: "spawn-reader" },
    envelopeTool,
    { ...child, id: "subagent:envelope", toolCallId: "spawn-envelope" },
    { ...spawn("tool:another-tool", "保留的其他工具"), toolName: "read_file" },
    { ...child, id: "subagent:another-tool", toolCallId: "another-tool" },
    spawn("tool:legacy", "保留的无关联启动"),
    { ...legacyChild, id: "subagent:legacy" },
    spawn("unstructured-entry", "保留的非规范标识启动"),
    { ...child, id: "subagent:unknown", toolCallId: "unstructured-entry" },
  ]);
  assert.doesNotMatch(markup, /隐藏的稳定标识启动|隐藏的结果关联启动|隐藏的实时启动/u);
  assert.match(markup, /保留的先前轮次启动/u);
  assert.match(markup, /保留的其他工具/u);
  assert.match(markup, /保留的无关联启动/u);
  assert.match(markup, /保留的非规范标识启动/u);
});
