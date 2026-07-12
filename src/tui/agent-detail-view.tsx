import React from "react";
import { Box, Text } from "ink";
import type { AgentNavigationItem, AgentTimelineItem } from "./agent-navigation.js";
import { terminalWidth, truncateTerminalText, visualRows } from "./terminal-width.js";

export interface AgentDetailViewProps {
  agent: AgentNavigationItem;
  renderWidth?: number;
  timelineLimit?: number;
  visibleRows?: number;
  startOffsetRows?: number;
}

const STATUS_MARKER = {
  idle: "○",
  queued: "○",
  running: "✽",
  completed: "✓",
  partial: "!",
  failed: "×",
  timed_out: "×",
  cancelled: "−",
} as const;

type DetailTone = "normal" | "muted" | "current" | "failed";

interface DetailRow {
  text: string;
  tone: DetailTone;
}

interface DetailBlock {
  kind: "title" | "status" | "task" | "current" | "summary" | "timeline-heading" | "timeline";
  rows: DetailRow[];
}

export function AgentDetailView({
  agent,
  renderWidth = 80,
  timelineLimit = 20,
  visibleRows,
  startOffsetRows = 0,
}: AgentDetailViewProps): React.ReactNode {
  const blocks = buildAgentDetailBlocks(agent, { renderWidth, timelineLimit });
  const start = Math.max(0, Math.floor(startOffsetRows));
  const limit = visibleRows === undefined ? undefined : Math.max(0, Math.floor(visibleRows));
  const visible = visibleDetailRows(blocks, start, limit);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column">
      {visible.map((row, index) => (
        <Text
          key={`${start + index}:${row.text}`}
          wrap="truncate"
          dimColor={row.tone === "muted"}
          bold={row.tone === "current"}
          color={row.tone === "current" ? "cyan" : row.tone === "failed" ? "red" : undefined}
        >
          {row.text || " "}
        </Text>
      ))}
    </Box>
  );
}

function visibleDetailRows(
  blocks: readonly DetailBlock[],
  start: number,
  limit?: number,
): DetailRow[] {
  if (limit === 0) return [];
  if (start > 0) return visibleScrolledBlocks(blocks, start, limit);
  if (limit === undefined) return blocks.flatMap((block) => block.rows);

  const totalRows = blocks.reduce((total, block) => total + block.rows.length, 0);
  if (totalRows <= limit) return blocks.flatMap((block) => block.rows);

  const titleBlocks = blocks.filter((block) => block.kind === "title" || block.kind === "status");
  const timelineBlocks = blocks.filter((block) => block.kind === "timeline");
  const sectionBlocks = blocks.filter(
    (block) => block.kind === "task" || block.kind === "current" || block.kind === "summary",
  );
  const selected: DetailBlock[] = [];
  let remaining = limit;

  for (const block of titleBlocks) {
    if (block.rows.length > remaining) break;
    selected.push(block);
    remaining -= block.rows.length;
  }

  // 有时间轴时预留最近一个完整事件，避免任务文本把有限视口全部占满。
  const newestTimeline = timelineBlocks.at(-1);
  const timelineReserve = newestTimeline
    ? newestTimeline.rows.length + (remaining > newestTimeline.rows.length ? 1 : 0)
    : 0;
  for (const block of sectionBlocks) {
    if (block.rows.length > remaining - timelineReserve) continue;
    selected.push(block);
    remaining -= block.rows.length;
  }

  const pickedTimeline: DetailBlock[] = [];
  const timelineHeading = blocks.find((block) => block.kind === "timeline-heading");
  const headingReserve = timelineHeading?.rows.length ?? 0;
  for (let index = timelineBlocks.length - 1; index >= 0; index -= 1) {
    const block = timelineBlocks[index]!;
    if (block.rows.length > remaining - headingReserve) break;
    pickedTimeline.unshift(block);
    remaining -= block.rows.length;
  }
  if (pickedTimeline.length > 0) {
    if (timelineHeading && timelineHeading.rows.length <= remaining) {
      selected.push(timelineHeading);
      remaining -= timelineHeading.rows.length;
    }
    if (pickedTimeline.length < timelineBlocks.length && remaining > 0) {
      selected.push({
        kind: "timeline-heading",
        rows: [{ text: "  … earlier events", tone: "muted" }],
      });
    }
    selected.push(...pickedTimeline);
  }

  return selected.flatMap((block) => block.rows).slice(0, limit);
}

/** 手动滚动时把起点吸附到事件边界，绝不从一个事件的续行中间开始。 */
function visibleScrolledBlocks(
  blocks: readonly DetailBlock[],
  start: number,
  limit?: number,
): DetailRow[] {
  let consumed = 0;
  let blockIndex = blocks.length;
  for (let index = 0; index < blocks.length; index += 1) {
    const next = consumed + blocks[index]!.rows.length;
    if (next > start) {
      blockIndex = index;
      break;
    }
    consumed = next;
  }
  const rows: DetailRow[] = [];
  for (let index = blockIndex; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (limit !== undefined && rows.length + block.rows.length > limit) break;
    rows.push(...block.rows);
  }
  return rows;
}

export function buildAgentDetailRows(
  agent: AgentNavigationItem,
  options: { renderWidth?: number; timelineLimit?: number } = {},
): string[] {
  return buildAgentDetailBlocks(agent, options).flatMap((block) =>
    block.rows.map((row) => row.text),
  );
}

function buildAgentDetailBlocks(
  agent: AgentNavigationItem,
  options: { renderWidth?: number; timelineLimit?: number } = {},
): DetailBlock[] {
  const width = normalizeWidth(options.renderWidth);
  const limit = normalizeTimelineLimit(options.timelineLimit);
  const name = shortAgentTitle(agent, width);
  const completionPolicy =
    agent.completionPolicy === "optional" ? "background" : agent.completionPolicy;
  const metadata = [agent.status, agent.mode, completionPolicy].filter(Boolean).join(" · ");
  const blocks: DetailBlock[] = [
    singleRowBlock("title", truncateTerminalText(`← Main / ${name}`, width), "normal"),
    singleRowBlock(
      "status",
      truncateTerminalText(`${STATUS_MARKER[agent.status]} ${metadata}`, width),
      agent.status === "failed" || agent.status === "timed_out" ? "failed" : "muted",
    ),
  ];

  appendSection(blocks, "task", "Task", agent.task, width);
  appendSection(blocks, "current", "Current", agent.currentAction, width);
  appendSection(blocks, "summary", "Summary", agent.summary, width);

  const timeline = agent.timeline ?? [];
  if (timeline.length > 0) {
    blocks.push(singleRowBlock("timeline-heading", "Timeline", "normal"));
    const visible = timeline.slice(-limit);
    const hidden = timeline.length - visible.length;
    if (hidden > 0) {
      blocks.push(
        singleRowBlock(
          "timeline-heading",
          truncateTerminalText(`  … ${hidden} earlier events`, width),
          "muted",
        ),
      );
    }
    visible.forEach((item, index) => {
      const current = index === visible.length - 1;
      blocks.push({ kind: "timeline", rows: timelineRows(item, width, current) });
    });
  }

  return blocks;
}

function singleRowBlock(kind: DetailBlock["kind"], text: string, tone: DetailTone): DetailBlock {
  return { kind, rows: [{ text, tone }] };
}

function appendSection(
  blocks: DetailBlock[],
  kind: "task" | "current" | "summary",
  label: string,
  content: string | undefined,
  width: number,
): void {
  const cleaned = cleanDisplayText(content);
  if (!cleaned) return;
  const prefix = width < 24 ? `${label}\n  ` : `${label.padEnd(8)} `;
  blocks.push({
    kind,
    rows: prefixedRows(prefix, cleaned, width, kind === "summary" ? 2 : 3, "normal"),
  });
}

function timelineRows(item: AgentTimelineItem, width: number, current: boolean): DetailRow[] {
  const tone: DetailTone =
    item.kind === "tool" && item.status === "failed" ? "failed" : current ? "current" : "muted";
  switch (item.kind) {
    case "thinking":
      return prefixedRows("… ", cleanDisplayText(item.content) || "Thinking", width, 2, tone);
    case "message":
      return prefixedRows("✦ ", cleanDisplayText(item.content), width, 2, tone);
    case "tool": {
      const marker = item.status === "failed" ? "×" : item.status === "completed" ? "✓" : "›";
      const toolName = formatToolName(cleanDisplayText(item.name));
      const target = cleanDisplayText(item.target);
      // 成功工具的 summary 当前是原始 result，默认视图不把源码/搜索结果铺开。
      const failure = item.status === "failed" ? cleanDisplayText(item.summary) : "";
      return prefixedRows(
        `${marker} `,
        `${toolName}${target ? `  ${target}` : ""}${failure ? ` · ${failure}` : ""}`,
        width,
        2,
        tone,
      );
    }
  }
}

function prefixedRows(
  prefix: string,
  content: string,
  width: number,
  maxRows: number,
  tone: DetailTone,
): DetailRow[] {
  if (prefix.includes("\n")) {
    const [label, indent = ""] = prefix.split("\n", 2);
    const wrapped = wrapWithIndent(content, indent, width, Math.max(1, maxRows - 1));
    return [
      { text: truncateTerminalText(label!, width), tone },
      ...wrapped.map((text) => ({ text, tone })),
    ];
  }
  const indent = " ".repeat(Math.min(terminalWidth(prefix), Math.max(0, width - 1)));
  const firstWidth = Math.max(1, width - terminalWidth(prefix));
  const firstParts = visualRows(content, firstWidth);
  const first = `${prefix}${firstParts.shift() ?? ""}`;
  const continuation = firstParts.flatMap((part) =>
    visualRows(part, Math.max(1, width - terminalWidth(indent))),
  );
  const rows = [
    truncateTerminalText(first, width),
    ...continuation.map((part) => `${indent}${part}`),
  ];
  return capRows(rows, width, maxRows).map((text) => ({ text, tone }));
}

function wrapWithIndent(content: string, indent: string, width: number, maxRows: number): string[] {
  const contentWidth = Math.max(1, width - terminalWidth(indent));
  return capRows(
    visualRows(content, contentWidth).map((row) => `${indent}${row}`),
    width,
    maxRows,
  );
}

function capRows(rows: readonly string[], width: number, maxRows: number): string[] {
  if (rows.length <= maxRows) return [...rows];
  const visible = rows.slice(0, maxRows);
  visible[maxRows - 1] = truncateTerminalText(`${visible[maxRows - 1]}…`, width);
  return visible;
}

function cleanDisplayText(value: string | undefined): string {
  return (value ?? "")
    .replace(/^\s*(?:\[Subagent\]\s*)+/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortAgentTitle(agent: AgentNavigationItem, width: number): string {
  const explicit = cleanDisplayText(agent.agentName);
  if (explicit) return explicit;
  const task = cleanDisplayText(agent.task) || "Agent";
  return truncateTerminalText(task, Math.max(8, Math.min(32, width - 9)));
}

function formatToolName(name: string): string {
  return (
    name
      .split(/[_-]+/u)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" ") || "Tool"
  );
}

function normalizeWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 8) return 80;
  return Math.floor(value);
}

function normalizeTimelineLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 20;
  return Math.min(100, Math.floor(value));
}
