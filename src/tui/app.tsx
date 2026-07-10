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

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
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
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { LayoutShell } from "./layout-shell.js";
import { MessageList } from "./message-list.js";
import { StatusBar } from "./status-bar.js";
import type { TuiEntry } from "./tui-reporter.js";
import { resolveKeybinding } from "./keybindings/resolver.js";
import { ToolCardFocusProvider } from "./tool-card.js";
import { buildTranscriptLayout } from "./transcript-layout.js";
import {
  fitHelpPanelMaxItems,
  InteractiveHelpPanel,
  type InteractiveHelpPanelProps,
} from "./help-panel.js";
import {
  approvalPanelContentWidth,
  measureApprovalPanelRows,
  type InteractiveApprovalPanelProps,
} from "./approval-panel.js";
import type { ApprovalNotice } from "../approval/manager.js";

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
  /** MCP 启动摘要(Logo 展示) */
  mcpSummary?: string;
  /** 当前任务摘要(Logo/状态区展示) */
  taskSummary?: string;
  /** 当前运行中输入队列长度 */
  queuedCount?: number;
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
  mcpSummary,
  taskSummary,
  queuedCount = 0,
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
  const inputDisabled = focusedDialog !== null;
  const inlineModal = focusedDialog?.layer === "modal" && focusedDialog.id === "approval:pending";
  const modal =
    focusedDialog?.layer === "modal" && !inlineModal ? focusedDialog.content : undefined;
  const transcriptWrapWidth = Math.max(20, columns - 6);
  const approvalNotice = inlineModal
    ? approvalNoticeFromContent(focusedDialog.content)
    : undefined;
  const [approvalDiffExpanded, setApprovalDiffExpanded] = useState(false);
  const controlledApproval =
    inlineModal && React.isValidElement<InteractiveApprovalPanelProps>(focusedDialog.content)
      ? React.cloneElement(focusedDialog.content, {
          diffExpanded: approvalDiffExpanded,
          onDiffExpandedChange: setApprovalDiffExpanded,
        })
      : focusedDialog?.content;
  const dialogLayout = measureGenericDialogLayout(controlledApproval, {
    active: focusedDialog !== null && !inlineModal,
    rows,
    columns,
  });
  const overlay =
    focusedDialog?.layer === "overlay" || inlineModal ? dialogLayout.content : undefined;
  const approvalRows = approvalNotice
    ? measureApprovalPanelRows(approvalNotice, {
        diffExpanded: approvalDiffExpanded,
        wrapWidth: approvalPanelContentWidth(columns),
      })
    : 0;
  const genericDialogRows = dialogLayout.rows;
  const [expandedToolKey, setExpandedToolKey] = useState<string | null>(null);
  const transcriptEntries = useMemo<TuiEntry[]>(
    () => [
      {
        kind: "logo",
        model,
        cwd: workDir,
        sessionMode,
        permissionMode,
        mcpSummary,
        taskSummary,
      },
      ...entries,
    ],
    [entries, mcpSummary, model, permissionMode, sessionMode, taskSummary, workDir],
  );
  const transcriptLayout = useMemo(
    () =>
      buildTranscriptLayout(transcriptEntries, {
        wrapWidth: transcriptWrapWidth,
        expandedToolKey,
        approvalRows,
      }),
    [approvalRows, expandedToolKey, transcriptEntries, transcriptWrapWidth],
  );
  const transcriptTotalRows = transcriptLayout.contentRows;
  const transcriptRows = Math.max(
    inputDisabled ? 0 : 6,
    rows - 8 - genericDialogRows - transcriptLayout.approvalRows,
  );
  const lastLayoutItem = transcriptLayout.items.at(-1);
  const lastToolKey = lastLayoutItem?.entry.kind === "tool" ? lastLayoutItem.key : null;
  const lastToolExpanded = lastToolKey !== null && expandedToolKey === lastToolKey;
  const [transcriptView, setTranscriptView] = useState<TranscriptViewState>({
    scrollRows: null,
    newMessageCount: 0,
  });
  const previousEntryCount = useRef(entries.length);
  const transcriptViewportRows = Math.max(
    1,
    transcriptRows - (transcriptView.newMessageCount > 0 ? 1 : 0),
  );

  useInput((input, key) => {
    const owner = resolveAppInputOwner(input, key, {
      running,
      modal: inputDisabled,
      canToggleTool: lastToolKey !== null,
    });
    if (owner === "tool-card" && lastToolKey) {
      setExpandedToolKey((current) => (current === lastToolKey ? null : lastToolKey));
      return;
    }

    if (owner === "transcript") {
      const transcriptAction = resolveTranscriptScrollKey(key);
      if (!transcriptAction) return;
      setTranscriptView((current) => {
        const scrollRows = nextTranscriptScroll(
          current.scrollRows,
          transcriptAction,
          transcriptViewportRows,
          transcriptTotalRows,
        );
        return {
          scrollRows,
          newMessageCount: scrollRows === null ? 0 : current.newMessageCount,
        };
      });
      return;
    }

    if (owner !== "global") return;
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
    setTranscriptView((current) => {
      if (current.scrollRows === null) return current;
      const scrollRows = clampScrollRows(
        current.scrollRows,
        transcriptViewportRows,
        transcriptTotalRows,
      );
      return scrollRows === current.scrollRows ? current : { ...current, scrollRows };
    });
  }, [transcriptTotalRows, transcriptViewportRows]);

  useEffect(() => {
    const addedEntries = Math.max(0, entries.length - previousEntryCount.current);
    previousEntryCount.current = entries.length;
    if (addedEntries === 0) return;
    setTranscriptView((current) =>
      current.scrollRows === null
        ? current
        : { ...current, newMessageCount: current.newMessageCount + addedEntries },
    );
  }, [entries.length]);

  useEffect(() => {
    setApprovalDiffExpanded(false);
  }, [approvalNotice?.taskId]);

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

  const phase = approvalNotice ? "approval" : queuedCount > 0 ? "queued" : running ? "running" : "idle";
  const runtimeTaskSummary =
    queuedCount > 0 ? `${queuedCount} queued` : taskSummary ?? (thinkingEffort === "off" ? undefined : `think ${thinkingEffort}`);
  const status = (
    <StatusBar
      phase={phase}
      sessionMode={sessionMode}
      permissionMode={permissionMode}
      contextSummary={provider}
      taskSummary={runtimeTaskSummary}
      renderWidth={Math.max(1, columns - 2)}
    />
  );
  const transcript = (
    <>
      {/* 消息列表:统一走 MessageList,由 shouldRenderStatically + MessageRow.memo 控制静态行。 */}
      <Box flexDirection="column" height={transcriptRows} overflowY="hidden" paddingX={1}>
        {transcriptView.newMessageCount > 0 && (
          <Text color="cyan">↓ {transcriptView.newMessageCount} new messages</Text>
        )}
        <ToolCardFocusProvider expanded={lastToolExpanded}>
          <MessageList
            layout={transcriptLayout}
            isStreaming={isStreaming}
            viewportRows={transcriptViewportRows}
            scrollOffsetRows={transcriptView.scrollRows ?? 0}
            estimatedRowHeight={3}
            overscanRows={0}
            virtualizeThreshold={0}
            scrollToBottom={transcriptView.scrollRows === null}
            preserveVirtualSpacers={false}
          />
        </ToolCardFocusProvider>
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
        acceptsInput={(input, key) =>
          resolveAppInputOwner(input, key, {
            running,
            modal: inputDisabled,
            canToggleTool: lastToolKey !== null,
          }) === "input"
        }
        slashCommandSuggestions={slashCommandSuggestions}
        slashArgumentSuggestions={slashArgumentSuggestions}
        fileMentionSuggestions={fileMentionSuggestions}
        onSubmit={onSubmit}
      />
    </Box>
  );

  return (
    <LayoutShell
      status={status}
      transcript={transcript}
      bottom={bottom}
      overlay={overlay}
      modal={modal}
      height={rows}
    />
  );
}

interface GenericDialogLayout {
  content: React.ReactNode;
  rows: number;
}

function measureGenericDialogLayout(
  content: React.ReactNode,
  options: { active: boolean; rows: number; columns: number },
): GenericDialogLayout {
  if (!options.active) return { content, rows: 0 };

  const maxRows = Math.max(3, options.rows - 9);
  const width = Math.max(20, options.columns - 8);
  if (React.isValidElement<InteractiveHelpPanelProps>(content) && content.type === InteractiveHelpPanel) {
    const fit = fitHelpPanelMaxItems(content.props.commands, {
      maxRows,
      width,
      selectedIndex: content.props.selectedIndex,
      scrollOffset: content.props.scrollOffset,
    });
    return {
      content: React.cloneElement(content, {
        maxItems: fit.maxItems,
        maxRows,
        renderWidth: width,
      }),
      rows: fit.maxRenderedRows,
    };
  }

  return { content, rows: Math.min(maxRows, 5) };
}

export type AppGlobalAction = "interrupt" | "exit" | "redraw";
type TranscriptScrollAction = "pageUp" | "pageDown" | "lineUp" | "lineDown" | "top" | "bottom";
type ToolCardAction = "toggle";
export type AppInputOwner = "global" | "modal" | "tool-card" | "transcript" | "input";

interface TranscriptViewState {
  scrollRows: number | null;
  newMessageCount: number;
}

interface AppInputKey {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  tab?: boolean;
  return?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
}

export function resolveAppInputOwner(
  input: string,
  key: AppInputKey,
  options: { running: boolean; modal: boolean; canToggleTool: boolean },
): AppInputOwner {
  if (resolveAppKeyEvent(input, key, options.running)) return "global";
  if (options.modal) return "modal";
  if (resolveToolCardToggleKey(input, key, options.canToggleTool, false)) return "tool-card";
  if (resolveTranscriptScrollKey(key)) return "transcript";
  return "input";
}

export function resolveAppKeyEvent(
  input: string,
  key: AppInputKey,
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
}, blocked = false): TranscriptScrollAction | null {
  if (blocked) return null;
  if (key.pageUp) return "pageUp";
  if (key.pageDown) return "pageDown";
  if (key.shift && key.upArrow) return "lineUp";
  if (key.shift && key.downArrow) return "lineDown";
  if (key.ctrl && key.upArrow) return "lineUp";
  if (key.ctrl && key.downArrow) return "lineDown";
  if (key.ctrl && key.home) return "top";
  if (key.ctrl && key.end) return "bottom";
  return null;
}

export function resolveToolCardToggleKey(
  input: string,
  key: { ctrl?: boolean; shift?: boolean; meta?: boolean },
  canToggle: boolean,
  blocked: boolean,
): ToolCardAction | null {
  if (!canToggle || blocked) return null;
  const resolved = resolveKeybinding({ input, key }, "Transcript");
  return resolved?.kind === "action" && resolved.action === "transcript:toggleShowAll"
    ? "toggle"
    : null;
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

function approvalNoticeFromContent(content: React.ReactNode): ApprovalNotice | undefined {
  if (!React.isValidElement<Partial<InteractiveApprovalPanelProps>>(content)) return undefined;
  const props = content.props;
  if (
    typeof props.taskId !== "string" ||
    typeof props.toolName !== "string" ||
    typeof props.args !== "string" ||
    typeof props.message !== "string"
  ) {
    return undefined;
  }
  return {
    taskId: props.taskId,
    toolName: props.toolName,
    args: props.args,
    message: props.message,
    ...(props.preview ? { preview: props.preview } : {}),
    ...(props.diff ? { diff: props.diff } : {}),
  };
}
