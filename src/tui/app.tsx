// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React 19)。
// 布局:LogoHeader → 消息列表(全部条目,React.memo 跳过静态) → spinner → 输入框。
//
// 关键架构(三路子代理排查确认):
//   不用 ink 的 <Static> 组件——它靠 items.length 追踪已渲染项,当条目在
//   live/static 间迁移导致 Static 子树节点身份变化时,reconciler 会清空
//   fullStaticOutput 并把所有历史条目重新裸写到 stdout,产生滚雪球重复。
//   Claude Code 也不用 <Static>(源码确认),靠差分渲染 + alt screen。
//
//   正确方案:所有条目留同一渲染树,用 React.memo(MessageRow 已有)跳过静态条目。
//   配合 render() 的 alternateScreen:true(进入 alt buffer,内容不进 scrollback,
//   退出时恢复主屏),彻底杜绝重复输出。
//   alt buffer 下 ink 只重绘可视区域(差分渲染),历史条目靠 React.memo 零 diff。

import React, { memo, useEffect, useMemo, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import { appendFileSync } from "node:fs";
import { InputBox } from "./input-box.js";
import type {
  SlashArgumentSuggestionSource,
  SuggestionSource,
} from "./input-controller.js";
import {
  pickFocusedDialog,
  type DialogRequest,
} from "./dialog-arbiter.js";
import { LogoPanel } from "./logo-panel.js";
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { LayoutShell } from "./layout-shell.js";
import { MessageList } from "./message-list.js";
import { StatusBar } from "./status-bar.js";
import type { TuiEntry } from "./tui-reporter.js";
import { resolveKeybinding } from "./keybindings/resolver.js";

/** 诊断日志:写文件(绕过 ink patchConsole 劫持),只在 TUI_DEBUG 时 */
function dbg(msg: string): void {
  if (process.env.TUI_DEBUG) {
    appendFileSync(".claw/tui-debug.log", `${new Date().toISOString()} ${msg}\n`);
  }
}

export interface AppProps {
  /** 模型名(Logo 展示) */
  model: string;
  /** Provider 名称(状态区展示) */
  provider?: string;
  /** 工作区(Logo 展示) */
  workDir: string;
  /** Session 选择模式(状态区展示) */
  sessionMode?: string;
  /** Permission 模式(状态区展示) */
  permissionMode?: string;
  /** 思考强度(状态区展示) */
  thinkingEffort?: string;
  /** 当前对话流条目(reporter 增量更新) */
  entries: TuiEntry[];
  /** 是否正在运行(idle 时聚焦输入框) */
  running: boolean;
  /** Slash command 候选源 */
  slashCommandSuggestions?: SuggestionSource;
  /** Slash command 参数候选源 */
  slashArgumentSuggestions?: SlashArgumentSuggestionSource;
  /** @ 文件候选源 */
  fileMentionSuggestions?: SuggestionSource;
  /** 当前请求展示的 overlay/modal,由 priority 仲裁出唯一焦点弹窗 */
  dialogRequests?: DialogRequest[];
  /** 用户提交一条消息时触发(repl 调 engine.run) */
  onSubmit: (text: string) => void;
  onInterrupt?: () => void;
  onExit?: () => void;
  onRedraw?: () => void;
}

export function App({
  model,
  provider = "openai",
  workDir,
  sessionMode = "new",
  permissionMode = "ask",
  thinkingEffort = "off",
  entries,
  running,
  slashCommandSuggestions,
  slashArgumentSuggestions,
  fileMentionSuggestions,
  dialogRequests = [],
  onSubmit,
  onInterrupt,
  onExit,
  onRedraw,
}: AppProps): React.ReactNode {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  const focusedDialog = pickFocusedDialog(dialogRequests);
  const modal = focusedDialog?.layer === "modal" ? focusedDialog.content : undefined;
  const overlay = focusedDialog?.layer === "overlay" ? focusedDialog.content : undefined;
  const inputDisabled = modal !== undefined;
  const transcriptRows = Math.max(inputDisabled ? 3 : 6, rows - (inputDisabled ? 13 : 8));
  const transcriptWrapWidth = Math.max(20, columns - 6);
  const getEntryRows = useMemo(
    () => (entry: TuiEntry) => estimateEntryRows(entry, transcriptWrapWidth),
    [transcriptWrapWidth],
  );
  const transcriptTotalRows = useMemo(
    () => estimateTranscriptRows(entries, transcriptWrapWidth),
    [entries, transcriptWrapWidth],
  );
  const [transcriptScrollRows, setTranscriptScrollRows] = useState<number | null>(null);

  useInput((input, key) => {
    const transcriptAction = resolveTranscriptScrollKey(key, running);
    if (transcriptAction) {
      setTranscriptScrollRows((current) =>
        nextTranscriptScroll(current, transcriptAction, transcriptRows, transcriptTotalRows),
      );
      return;
    }

    const action = resolveAppKeyEvent(input, key, running);
    if (action === "interrupt") {
      onInterrupt?.();
      return;
    }
    if (action === "redraw") {
      onRedraw?.();
      return;
    }
    if (action === "exit") {
      onExit?.();
      exit();
    }
  });

  useEffect(() => {
    setTranscriptScrollRows((current) =>
      current === null ? null : clampScrollRows(current, transcriptRows, transcriptTotalRows),
    );
  }, [transcriptRows, transcriptTotalRows]);

  // 是否仍有"主动流式":running 且末尾是流式 assistant / thinking / running tool
  const isStreaming = running && isActivelyStreaming(entries);
  // spinner 阶段:据末尾条目状态选
  const spinnerMode = pickSpinnerMode(entries, isStreaming);
  const showSpinner = running && !inputDisabled && spinnerMode !== "responding";

  // 诊断:记录每次渲染的 entries 状态
  dbg(`render: entries=${entries.length} running=${running} streaming=${isStreaming}`);
  entries.forEach((e, i) => {
    const c = e.kind === "user" || e.kind === "assistant" ? e.content.slice(0, 40) : e.kind;
    dbg(`  [${i}] ${e.kind}: ${c}`);
  });

  const header = <StableLogoPanel model={model} cwd={workDir} />;
  const status = (
    <StatusBar
      model={model}
      provider={provider}
      cwd={workDir}
      sessionMode={sessionMode}
      permissionMode={permissionMode}
      thinkingEffort={thinkingEffort}
    />
  );
  const transcript = (
    <>
      {/* 消息列表:统一走 MessageList,由 shouldRenderStatically + MessageRow.memo 控制静态行。 */}
      <Box flexDirection="column" height={transcriptRows} overflowY="hidden" paddingX={1}>
        <MessageList
          entries={entries}
          isStreaming={isStreaming}
          viewportRows={transcriptRows}
          scrollOffsetRows={transcriptScrollRows ?? 0}
          estimatedRowHeight={3}
          getEntryRows={getEntryRows}
          wrapWidth={transcriptWrapWidth}
          overscanRows={0}
          virtualizeThreshold={0}
          scrollToBottom={transcriptScrollRows === null}
          preserveVirtualSpacers={false}
        />
      </Box>

      {/* 思考/spinner:据末尾状态显示对应 mode */}
      {showSpinner && (
        <Box paddingX={1}>
          <Spinner mode={spinnerMode} />
        </Box>
      )}
    </>
  );
  const bottom = (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={inputDisabled ? "gray" : "green"}
      paddingX={1}
    >
      <InputBox
        disabled={inputDisabled}
        disabledLabel="Use dialog controls"
        slashCommandSuggestions={slashCommandSuggestions}
        slashArgumentSuggestions={slashArgumentSuggestions}
        fileMentionSuggestions={fileMentionSuggestions}
        onSubmit={onSubmit}
      />
    </Box>
  );

  return (
    <LayoutShell
      header={header}
      status={status}
      transcript={transcript}
      bottom={bottom}
      overlay={overlay}
      modal={modal}
      height={rows}
    />
  );
}

const StableLogoPanel = memo(LogoPanel);

export type AppGlobalAction = "interrupt" | "exit" | "redraw";
type TranscriptScrollAction = "pageUp" | "pageDown" | "lineUp" | "lineDown" | "top" | "bottom";

export function resolveAppKeyEvent(
  input: string,
  key: {
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    tab?: boolean;
    return?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    home?: boolean;
    end?: boolean;
    backspace?: boolean;
    delete?: boolean;
    escape?: boolean;
  },
  running: boolean,
): AppGlobalAction | null {
  const resolved = resolveKeybinding({ input, key }, "Global");
  if (!resolved || resolved.kind !== "action") return null;
  if (resolved.action === "app:interrupt") return running ? "interrupt" : null;
  if (resolved.action === "app:exit") return "exit";
  if (resolved.action === "app:redraw") return "redraw";
  return null;
}

/**
 * 判断当前是否"主动流式":末尾是流式 assistant,或 thinking/running tool 占位。
 */
function isActivelyStreaming(entries: TuiEntry[]): boolean {
  const last = entries[entries.length - 1];
  if (!last) return false;
  return (
    last.kind === "assistant" ||
    last.kind === "thinking" ||
    (last.kind === "tool" && last.status === "running")
  );
}

/** 据 entries 末尾状态选 SpinnerMode */
function pickSpinnerMode(entries: TuiEntry[], isStreaming: boolean): SpinnerMode {
  const last = entries[entries.length - 1];
  if (!last) return "requesting";
  if (last.kind === "thinking") return "thinking";
  if (last.kind === "tool" && last.status === "running") return "tool-use";
  if (last.kind === "assistant" && isStreaming) return "responding";
  return "requesting";
}

export function resolveTranscriptScrollKey(key: {
  ctrl?: boolean;
  shift?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  home?: boolean;
  end?: boolean;
}, running = false): TranscriptScrollAction | null {
  if (key.pageUp) return "pageUp";
  if (key.pageDown) return "pageDown";
  if (running && key.upArrow && !key.ctrl && !key.shift) return "lineUp";
  if (running && key.downArrow && !key.ctrl && !key.shift) return "lineDown";
  if (key.shift && key.upArrow) return "lineUp";
  if (key.shift && key.downArrow) return "lineDown";
  if (key.ctrl && key.upArrow) return "lineUp";
  if (key.ctrl && key.downArrow) return "lineDown";
  if (key.ctrl && key.home) return "top";
  if (key.ctrl && key.end) return "bottom";
  return null;
}

export function nextTranscriptScroll(
  current: number | null,
  action: TranscriptScrollAction,
  viewportRows: number,
  totalRows: number,
): number | null {
  const maxScroll = maxTranscriptScroll(viewportRows, totalRows);
  const currentOffset = current ?? maxScroll;
  const page = Math.max(1, viewportRows - 2);

  switch (action) {
    case "pageUp":
      return clampScrollRows(currentOffset - page, viewportRows, totalRows);
    case "pageDown": {
      const next = clampScrollRows(currentOffset + page, viewportRows, totalRows);
      return next >= maxScroll ? null : next;
    }
    case "lineUp":
      return clampScrollRows(currentOffset - 1, viewportRows, totalRows);
    case "lineDown": {
      const next = clampScrollRows(currentOffset + 1, viewportRows, totalRows);
      return next >= maxScroll ? null : next;
    }
    case "top":
      return 0;
    case "bottom":
      return null;
  }
}

function clampScrollRows(offset: number, viewportRows: number, totalRows: number): number {
  return Math.min(Math.max(0, offset), maxTranscriptScroll(viewportRows, totalRows));
}

function maxTranscriptScroll(viewportRows: number, totalRows: number): number {
  return Math.max(0, totalRows - Math.max(1, viewportRows));
}

function estimateTranscriptRows(entries: readonly TuiEntry[], wrapWidth: number): number {
  return entries.reduce((total, entry) => total + estimateEntryRows(entry, wrapWidth), 0);
}

function estimateEntryRows(entry: TuiEntry, wrapWidth: number): number {
  if (entry.kind === "thinking") return 1;
  if (entry.kind === "tool") return entry.summary ? 2 : 1;
  const content = entry.kind === "user" || entry.kind === "assistant" || entry.kind === "system" ? entry.content : "";
  return estimateTextRows(content, wrapWidth) + 1;
}

function estimateTextRows(text: string, wrapWidth: number): number {
  const width = Math.max(8, Math.floor(wrapWidth));
  return text.split("\n").reduce((total, line) => {
    return total + Math.max(1, Math.ceil(line.length / width));
  }, 0);
}
