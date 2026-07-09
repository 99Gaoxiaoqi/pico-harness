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

export interface MessageListProps {
  /** 待渲染的条目 */
  entries: TuiEntry[];
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
}

/** 渲染一组 entries:逐条用 <MessageRow> 分发(轮次间加分隔线) */
export function MessageList({
  entries,
  isStreaming = false,
  viewportRows,
  scrollOffsetRows = 0,
  estimatedRowHeight,
  overscanRows,
  virtualizeThreshold,
  scrollToBottom,
}: MessageListProps): React.ReactNode {
  const window =
    viewportRows === undefined
      ? {
          visibleItems: entries,
          startIndex: 0,
          topSpacerRows: 0,
          bottomSpacerRows: 0,
        }
      : computeVirtualTranscript(entries, viewportRows, scrollOffsetRows, {
          estimatedRowHeight,
          overscanRows,
          virtualizeThreshold,
          scrollToBottom,
        });

  return (
    <Box flexDirection="column">
      {window.topSpacerRows > 0 && <Box height={window.topSpacerRows} />}
      {window.visibleItems.map((entry, i) => {
        const originalIndex = window.startIndex + i;
        const isLast = originalIndex === entries.length - 1;
        const prev = entries[originalIndex - 1];
        // 轮次分隔:遇到新的 user 消息,且前面已有内容时,加一条淡色分隔线
        const showSeparator = entry.kind === "user" && prev !== undefined;
        return (
          <React.Fragment key={originalIndex}>
            {showSeparator && <Separator />}
            <MessageRow
              entry={entry}
              isStatic={shouldRenderStatically(entry, isLast, isStreaming)}
              isLast={isLast}
            />
          </React.Fragment>
        );
      })}
      {window.bottomSpacerRows > 0 && <Box height={window.bottomSpacerRows} />}
    </Box>
  );
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
