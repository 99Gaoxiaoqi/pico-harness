// 单条消息行:对标 Claude Code 的 MessageRow.tsx。
//
// 核心优化:用 React.memo 包裹。isStatic 且"内容未变"时返回 true 跳过重渲染,
// 避免每次 onTextDelta 增量都重渲染整条历史对话。这与 Claude Code 的
// areMessageRowPropsEqual 思路一致——只在"确定不变"时跳过,fail-safe 时重渲染。
//
// 分发逻辑(按 entry.kind):
//   - user      : 绿色 ❯ + 内容(提交即固定)
//   - assistant : isStatic 用 CompletedText(代码块着色,非流式);
//                 否则用 StreamingText(末条流式中,按行增量渲染)
//   - system    : 淡色 • + 内容(本地控制面反馈)
//   - error     : 黄色 ! + 结构化错误信息
//   - logo      : 会话启动摘要,作为 transcript 首项
//   - tool      : 渲染 <ToolCard>(自带折叠/展开)
//   - thinking  : 返回 null(spinner 由 App 层渲染,不在此重复)

import React, { memo } from "react";
import { Box, Text } from "ink";
import type { TuiEntry } from "./tui-reporter.js";
import { CompletedText, StreamingText } from "./streaming-text.js";
import { ToolCard } from "./tool-card.js";
import { LogoPanel } from "./logo-panel.js";
import { visualRows } from "./terminal-width.js";

export interface MessageRowProps {
  /** 本条消息数据 */
  entry: TuiEntry;
  /** 是否已固化(由 shouldRenderStatically 判定):影响 assistant 渲染路径与 memo */
  isStatic: boolean;
  /** 是否为列表中最后一条:决定 tool 默认折叠状态 */
  isLast: boolean;
  toolStartOffsetRows?: number;
  toolVisibleRows?: number;
  wrapWidth?: number;
}

/** 单条消息行组件(React.memo 包裹) */
export const MessageRow = memo(MessageRowImpl, arePropsEqual);

function MessageRowImpl({
  entry,
  isStatic,
  isLast,
  toolStartOffsetRows,
  toolVisibleRows,
  wrapWidth,
}: MessageRowProps): React.ReactNode {
  switch (entry.kind) {
    case "logo":
      return (
        <LogoPanel
          model={entry.model}
          cwd={entry.cwd}
          sessionMode={entry.sessionMode}
          permissionMode={entry.permissionMode}
          mcpSummary={entry.mcpSummary}
          taskSummary={entry.taskSummary}
          renderWidth={wrapWidth}
          startOffsetRows={toolStartOffsetRows}
          visibleRows={toolVisibleRows}
        />
      );

    case "user":
      return (
        <MessageFrame marker="❯" markerColor="green" boldMarker>
          <Text wrap="wrap">{entry.content}</Text>
        </MessageFrame>
      );

    case "assistant":
      // isStatic:已固化走 CompletedText(代码块着色,整体 memo);
      // 否则(末条流式中)走 StreamingText(按行 stable/unstable 增量渲染)
      return (
        <MessageFrame marker="✦" markerColor="cyan">
          {isStatic ? <CompletedText content={entry.content} /> : <StreamingText content={entry.content} />}
        </MessageFrame>
      );

    case "error":
      return (
        <MessageFrame marker="!" markerColor="yellow" boldMarker>
          <Text color="yellow" wrap="wrap">
            {clipRows(
              buildErrorEntryRows(entry, wrapWidth),
              toolStartOffsetRows,
              toolVisibleRows,
            ).join("\n")}
          </Text>
        </MessageFrame>
      );

    case "system":
      return (
        <MessageFrame marker="•" markerColor="gray">
          <Text dimColor wrap="wrap">
            {entry.content}
          </Text>
        </MessageFrame>
      );

    case "tool":
      return (
        <ToolCard
          name={entry.name}
          args={entry.args}
          status={entry.status}
          summary={entry.summary}
          isLast={isLast}
          startOffsetRows={toolStartOffsetRows}
          visibleRows={toolVisibleRows}
          wrapWidth={wrapWidth}
        />
      );

    case "thinking":
      // thinking 占位由 App 层的 <Spinner> 渲染,这里不重复显示
      return null;

    default:
      return null;
  }
}

function MessageFrame({
  marker,
  markerColor,
  boldMarker = false,
  children,
}: {
  marker: string;
  markerColor: "green" | "cyan" | "gray" | "yellow";
  boldMarker?: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Box width={2}>
        <Text color={markerColor} bold={boldMarker}>
          {marker}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}

export function formatErrorEntry(entry: Extract<TuiEntry, { kind: "error" }>): string {
  const parts = [entry.message];
  if (entry.retryable !== undefined) parts.push(entry.retryable ? "retryable" : "not retryable");
  if (entry.action) parts.push(entry.action);
  return parts.join(" · ");
}

export function buildErrorEntryRows(
  entry: Extract<TuiEntry, { kind: "error" }>,
  wrapWidth = 80,
): string[] {
  return visualRows(formatErrorEntry(entry), Math.max(1, wrapWidth));
}

function clipRows(
  rows: string[],
  startOffsetRows: number | undefined,
  visibleRows: number | undefined,
): string[] {
  const rawStart = Math.max(0, Math.floor(startOffsetRows ?? 0));
  const start = rawStart === 0 ? 0 : Math.max(0, rawStart - 1);
  const end = visibleRows === undefined ? undefined : start + Math.max(0, Math.floor(visibleRows));
  return rows.slice(start, end);
}

/**
 * memo 比较器:返回 true 表示跳过重渲染(fail-safe——不确定时返回 false 重渲染)。
 *
 * 策略(对标 areMessageRowPropsEqual):
 *   1. 非静态条目(流式 assistant / running tool / thinking):必须重渲染,返回 false。
 *   2. 静态条目:逐字段对比关键字段(content / tool 的 name+args+status+summary),
 *      全部未变才返回 true 跳过。引用变化但内容相同也跳过(报告者会替换数组引用)。
 */
function arePropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  // isStatic 状态变化(如末条 assistant 从流式→固化)必须重渲染
  if (prev.isStatic !== next.isStatic) return false;

  // 末条身份会影响工具树形符号;变化时必须让该行刷新。
  if (prev.isLast !== next.isLast) return false;
  if (
    prev.toolStartOffsetRows !== next.toolStartOffsetRows ||
    prev.toolVisibleRows !== next.toolVisibleRows ||
    prev.wrapWidth !== next.wrapWidth
  ) {
    return false;
  }

  // 非静态:内容可能还在变,一律重渲染(fail-safe)
  if (!next.isStatic) return false;

  // 静态条目:按 kind 比对关键字段
  const a = prev.entry;
  const b = next.entry;
  if (a.kind !== b.kind) return false;

  switch (b.kind) {
    case "logo":
      return (
        a.kind === "logo" &&
        a.model === b.model &&
        a.cwd === b.cwd &&
        a.sessionMode === b.sessionMode &&
        a.permissionMode === b.permissionMode &&
        a.mcpSummary === b.mcpSummary &&
        a.taskSummary === b.taskSummary
      );
    case "user":
    case "system":
    case "assistant":
      // content 完全一致即跳过(报告者可能换数组引用,但 content 不变)
      return a.kind === b.kind && a.content === b.content;
    case "error":
      return (
        a.kind === "error" &&
        a.message === b.message &&
        a.retryable === b.retryable &&
        a.action === b.action
      );
    case "tool":
      // tool:全字段一致才跳过(状态/摘要都需稳定)
      return (
        a.kind === "tool" &&
        b.kind === "tool" &&
        a.name === b.name &&
        a.args === b.args &&
        a.status === b.status &&
        a.summary === b.summary
      );
    case "thinking":
      // thinking 永远是非静态的(见 shouldRenderStatically),不会走到这里
      return true;
    default:
      return false;
  }
}
