// 消息列表渲染 + isStatic 判定:对标 Claude Code 的消息流架构。
//
// 主要导出:
//   - shouldRenderStatically : 判定单条 entry 是否"已固定"(对标 Claude Code
//                               Messages.tsx 同名函数,规则按 tool/assistant
//                               resolve 状态而非数组索引切分)
//   - MessageList            : 渲染一组 entries,逐条用 <MessageRow> 分发
//   - LogoHeader             : 消息流首部的 logo 条目(替代原固定顶栏)
//
// 设计要点:
//   - 不再内联渲染,统一委托给 <MessageRow>(React.memo)。
//   - shouldRenderStatically 由 App 层逐条调用,决定 entry 进 Static 区还是动态区。

import React from "react";
import { Box, Text } from "ink";
import type { TuiEntry } from "./tui-reporter.js";
import { MessageRow } from "./message-row.js";
import { computeVirtualTranscript } from "./virtual-transcript.js";
import { visualRows, type TranscriptLayout } from "./transcript-layout.js";

export interface MessageListProps {
  /** App 预先生成的聚合条目与行高。 */
  layout: TranscriptLayout;
  /** 是否有流式进行中(用于判定末条 assistant) */
  isStreaming?: boolean;
  /** 可选:启用长 transcript 虚拟渲染时的视口行数 */
  viewportRows?: number;
  /** 可选:启用长 transcript 虚拟渲染时的滚动偏移行数 */
  scrollOffsetRows?: number;
  /** 可选:单条消息行高估算 */
  estimatedRowHeight?: number;
  /** 可选:视口上下额外渲染行数 */
  overscanRows?: number;
  /** 可选:低于或等于该条目数时不虚拟化,默认 200 */
  virtualizeThreshold?: number;
  /** 可选:忽略 scrollOffsetRows,直接渲染尾部窗口 */
  scrollToBottom?: boolean;
  /** 可选:虚拟窗口是否保留上下占位行,默认保留 */
  preserveVirtualSpacers?: boolean;
}

/** 渲染一组 entries:逐条用 <MessageRow> 分发(轮次间加分隔线) */
export function MessageList({
  layout,
  isStreaming = false,
  viewportRows,
  scrollOffsetRows = 0,
  estimatedRowHeight,
  overscanRows,
  virtualizeThreshold,
  scrollToBottom,
  preserveVirtualSpacers = true,
}: MessageListProps): React.ReactNode {
  const displayEntries = layout.entries;
  const threshold = normalizeNonNegativeRows(virtualizeThreshold, 200);
  const overscan = normalizeNonNegativeRows(overscanRows, 20);
  const virtualized = viewportRows !== undefined && displayEntries.length > threshold;
  let remainingWindowRows =
    !virtualized || viewportRows === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, viewportRows) + overscan * 2;
  const window =
    viewportRows === undefined
      ? {
          visibleItems: displayEntries,
          startIndex: 0,
          topSpacerRows: 0,
          bottomSpacerRows: 0,
          startOffsetRows: 0,
        }
      : computeVirtualTranscript(displayEntries, viewportRows, scrollOffsetRows, {
          estimatedRowHeight,
          getItemRows: (_entry, index) => layout.items[index]?.rows,
          overscanRows,
          virtualizeThreshold,
          scrollToBottom,
        });

  return (
    <Box flexDirection="column">
      {preserveVirtualSpacers && window.topSpacerRows > 0 && <Box height={window.topSpacerRows} />}
      {window.visibleItems.map((entry, i) => {
        const originalIndex = window.startIndex + i;
        const isLast = originalIndex === displayEntries.length - 1;
        const prev = displayEntries[originalIndex - 1];
        const item = layout.items[originalIndex];
        const rowsToSkip = i === 0 ? window.startOffsetRows : 0;
        const separatorRows = item?.separatorRows ?? 0;
        const contentRowsToSkip = Math.max(0, rowsToSkip - separatorRows);
        const estimatedRows = item?.rows ?? estimatedRowHeight;
        const remainingItemRows =
          estimatedRows === undefined
            ? remainingWindowRows
            : Math.max(0, estimatedRows - rowsToSkip);
        const visibleRows = Math.min(remainingItemRows, remainingWindowRows);
        remainingWindowRows = Math.max(0, remainingWindowRows - visibleRows);
        const visibleEntry = clipEntryTopRows(
          entry,
          contentRowsToSkip,
          visibleRows,
          layout.wrapWidth,
        );
        // 轮次分隔:遇到新的 user 消息,且前面已有内容时,加一条淡色分隔线
        const showSeparator = entry.kind === "user" && prev !== undefined && rowsToSkip === 0;
        const entryVisibleRows = Math.max(0, visibleRows - (showSeparator ? separatorRows : 0));
        return (
          <React.Fragment key={originalIndex}>
            {showSeparator && <Separator />}
            <MessageRow
              entry={visibleEntry}
              isStatic={shouldRenderStatically(visibleEntry, isLast, isStreaming)}
              isLast={isLast}
              toolStartOffsetRows={canClipInsideMessageRow(entry) ? contentRowsToSkip : undefined}
              toolVisibleRows={canClipInsideMessageRow(entry) ? entryVisibleRows : undefined}
              wrapWidth={layout.wrapWidth}
            />
          </React.Fragment>
        );
      })}
      {preserveVirtualSpacers && window.bottomSpacerRows > 0 && (
        <Box height={window.bottomSpacerRows} />
      )}
    </Box>
  );
}

function clipEntryTopRows(
  entry: TuiEntry,
  rowsToSkip: number,
  visibleRows: number | undefined,
  wrapWidth: number | undefined,
): TuiEntry {
  if (rowsToSkip <= 0) return entry;
  if (entry.kind !== "assistant" && entry.kind !== "user" && entry.kind !== "system") {
    return entry;
  }

  // MessageFrame 会重新绘制一行上边距,这里稍微多跳过正文顶部,
  // 让长流式回复优先保住最新尾行。
  const contentRowsToSkip = rowsToSkip;
  const contentRowsToKeep = Math.max(1, (visibleRows ?? 1) - 1);
  const content = clipTextTopRows(entry.content, contentRowsToSkip, contentRowsToKeep, wrapWidth);
  return { ...entry, content };
}

function canClipInsideMessageRow(entry: TuiEntry): boolean {
  return entry.kind === "tool" || entry.kind === "logo" || entry.kind === "error";
}

function clipTextTopRows(
  text: string,
  rowsToSkip: number,
  rowsToKeep: number,
  wrapWidth: number | undefined,
): string {
  if (rowsToSkip <= 0) return text;
  const rows = visualRows(text, normalizeWrapWidth(wrapWidth));
  return rows.slice(rowsToSkip, rowsToSkip + rowsToKeep).join("\n");
}

function normalizeWrapWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width) || width < 8) return 80;
  return Math.floor(width);
}

function normalizeNonNegativeRows(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/** 轮次分隔:淡色虚线,让多轮对话结构清晰 */
function Separator(): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text dimColor>─</Text>
    </Box>
  );
}

/**
 * 判定单条 entry 是否"已固定"(可进 Static 区,内容不再变化)。
 * 对标 Claude Code 的 shouldRenderStatically——按 tool resolve 状态判定,
 * 而非简单的数组索引切分。
 *
 * 规则:
 *   - user           → true(提交即固定)
 *   - system         → true(本地控制面反馈,提交即固定)
 *   - tool status=done/error → true(工具已 resolve)
 *   - tool status=running    → false(进行中)
 *   - assistant 非末条       → true(历史回复)
 *   - assistant 末条且 isStreaming → false(还在流式累积)
 *   - assistant 末条且非 streaming  → true(已固化)
 *   - thinking       → false(始终在动态区,spinner 据此显示)
 */
export function shouldRenderStatically(
  entry: TuiEntry,
  isLast: boolean,
  isStreaming: boolean,
): boolean {
  switch (entry.kind) {
    case "user":
    case "system":
    case "logo":
    case "error":
      return true;
    case "tool":
      // done/error 已 resolve → 固定;running → 动态
      return entry.status !== "running";
    case "assistant":
      if (!isLast) return true; // 历史回复必然固定
      // 末条:流式中 → 动态;否则固定
      return !isStreaming;
    case "thinking":
      return false;
    default:
      return false;
  }
}

/**
 * Logo 条目:消息流首部的标识行(替代原固定的 borderStyle="round" 顶栏)。
 * 对标 Claude Code——Logo 是消息列表的第一项,而非常驻顶栏。
 *
 * 显示:`pico · {model} · {workDir}` 一行,淡色处理不抢注意力。
 */
export function LogoHeader({
  model,
  workDir,
}: {
  model: string;
  workDir: string;
}): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text bold color="cyan">
        pico
      </Text>
      <Text dimColor>
        {" · "}
        {model} · {workDir}
      </Text>
    </Box>
  );
}
