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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { appendFileSync, mkdirSync } from "node:fs";
import { InputBox, type InputBoxStateSnapshot, type InputBoxSubmission } from "./input-box.js";
import type { SlashArgumentSuggestionSource, SuggestionSource } from "./input-controller.js";
import { pickFocusedDialog, type DialogRequest } from "./dialog-arbiter.js";
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { LayoutShell } from "./layout-shell.js";
import { MessageList } from "./message-list.js";
import { StatusBar } from "./status-bar.js";
import type { TuiEntry } from "./tui-reporter.js";
import { effectiveTuiRows, transcriptContentRows } from "./viewport-rows.js";
import { resolveKeybinding, type UserKeybindingConfig } from "./keybindings/resolver.js";
import { ToolCardFocusProvider } from "./tool-card.js";
import { buildTranscriptLayout } from "./transcript-layout.js";
import {
  fitHelpPanelMaxItems,
  InteractiveHelpPanel,
  type InteractiveHelpPanelProps,
} from "./help-panel.js";
import {
  approvalPanelContentWidth,
  isApprovalDialogId,
  measureApprovalPanelRows,
  type InteractiveApprovalPanelProps,
} from "./approval-panel.js";
import type { ApprovalNotice } from "../approval/manager.js";
import {
  parseSgrMouseInput,
  suspendProcessUntilContinued,
  useTerminalMouseMode,
} from "./mouse-input.js";
import { AskUserDialog, type AskUserDialogProps } from "./ask-user-dialog.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { ChangesDialogContent, type ChangesDialogContentProps } from "./changes-panel.js";
import { InspectorDialogContent, type InspectorDialogContentProps } from "./inspector.js";
import {
  createAgentNavigationState,
  MAIN_AGENT_ID,
  normalizeAgentNavigationItems,
  reconcileAgentNavigationState,
  reduceAgentNavigation,
  visibleAgentNavigationItems,
  type AgentNavigationEvent,
  type AgentNavigationItem,
} from "./agent-navigation.js";
import {
  AgentSwitcher,
  buildAgentSwitcherLayout,
  hitTestAgentSwitcherRow,
  measureAgentSwitcherRows,
} from "./agent-switcher.js";
import { AgentDetailView } from "./agent-detail-view.js";

/** 诊断日志:写文件(绕过 ink patchConsole 劫持),只在 TUI_DEBUG 时 */
function dbg(workDir: string, msg: string): void {
  if (process.env.TUI_DEBUG) {
    const paths = resolvePicoPaths(workDir);
    mkdirSync(paths.workspace.root, { recursive: true });
    appendFileSync(paths.workspace.debugLog, `${new Date().toISOString()} ${msg}\n`);
  }
}

const EMPTY_AGENT_ITEMS: readonly AgentNavigationItem[] = Object.freeze([]);

export interface AppProps {
  /** 模型名(Logo 展示) */
  model: string;
  /** 实际 providerID/modelID 路由(Logo 展示) */
  modelRouteId?: string;
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
  /** Main 与子代理的独立导航投影。 */
  agents?: readonly AgentNavigationItem[];
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
  onSubmit: (submission: InputBoxSubmission) => void;
  onInterrupt?: () => void;
  /** 权威内部 tool call ID；生产 TUI 用 Ctrl+E 打开完整 Inspector。 */
  onInspectTool?: (toolCallId: string) => void;
  onExit?: () => void;
  onRedraw?: () => void;
  /** User keybinding overrides loaded once at TUI startup. */
  keybindings?: UserKeybindingConfig;
  /** /rewind 等外部动作请求替换输入草稿。 */
  inputReplacement?: { sequence: number; text: string };
  /** 当前终端实际支持的剪贴板图片快捷键提示。 */
  imagePasteShortcutLabel?: string;
  /** Ctrl+L 经 Ink renderer 输出的过渡空帧，避免绕过帧记账。 */
  redrawBlank?: boolean;
}

export function App({
  model,
  modelRouteId,
  provider,
  workDir,
  sessionMode = "new",
  permissionMode = "yolo",
  thinkingEffort,
  mcpSummary,
  taskSummary,
  queuedCount = 0,
  entries,
  agents = EMPTY_AGENT_ITEMS,
  running,
  slashCommandSuggestions,
  slashArgumentSuggestions,
  fileMentionSuggestions,
  dialogRequests = [],
  onSubmit,
  onInterrupt,
  onInspectTool,
  onExit,
  onRedraw,
  keybindings,
  inputReplacement,
  imagePasteShortcutLabel,
  redrawBlank = false,
}: AppProps): React.ReactNode {
  const { exit, suspendTerminal } = useApp();
  const mouseMode = useTerminalMouseMode();
  const { rows: terminalRows, columns } = useWindowSize();
  // Ink 7.1 intentionally clears every full-height frame on Windows. Use the
  // same reduced viewport for every budget and the shell so bottom controls
  // stay visible while streaming updates remain incremental.
  const rows = effectiveTuiRows(terminalRows);
  const focusedDialog = pickFocusedDialog(dialogRequests);
  const allAgentItems = useMemo(() => normalizeAgentNavigationItems(agents), [agents]);
  const [agentNavigation, setAgentNavigation] = useState(createAgentNavigationState);
  const normalizedAgentItems = useMemo(
    () => visibleAgentNavigationItems(allAgentItems, agentNavigation.activeId),
    [agentNavigation.activeId, allAgentItems],
  );
  const hasSubagents = normalizedAgentItems.length > 1;
  const [seenTimelineCounts, setSeenTimelineCounts] = useState<Record<string, number>>({});
  const navigationItems = useMemo(
    () =>
      normalizedAgentItems.map((item) => ({
        ...item,
        unreadCount:
          item.kind === "subagent" && agentNavigation.activeId !== item.id
            ? Math.max(0, (item.timeline?.length ?? 0) - (seenTimelineCounts[item.id] ?? 0))
            : 0,
      })),
    [agentNavigation.activeId, normalizedAgentItems, seenTimelineCounts],
  );
  const activeAgent =
    agentNavigation.activeId === MAIN_AGENT_ID
      ? undefined
      : navigationItems.find((item) => item.id === agentNavigation.activeId);
  const inputDisabled = focusedDialog !== null || activeAgent !== undefined;
  const inlineModal = focusedDialog?.layer === "modal" && isApprovalDialogId(focusedDialog.id);
  const transcriptWrapWidth = Math.max(1, columns - 6);
  const approvalNotice = inlineModal ? approvalNoticeFromContent(focusedDialog.content) : undefined;
  const [approvalDiffExpanded, setApprovalDiffExpanded] = useState(true);
  const controlledApproval =
    inlineModal && React.isValidElement<InteractiveApprovalPanelProps>(focusedDialog.content)
      ? React.cloneElement(focusedDialog.content, {
          diffExpanded: approvalDiffExpanded,
          onDiffExpandedChange: setApprovalDiffExpanded,
          keybindings,
        })
      : focusedDialog?.content;
  const dialogLayout = measureGenericDialogLayout(controlledApproval, {
    active: focusedDialog !== null && !inlineModal,
    rows,
    columns,
  });
  const overlay =
    focusedDialog?.layer === "overlay" || inlineModal ? dialogLayout.content : undefined;
  const modal = focusedDialog?.layer === "modal" && !inlineModal ? dialogLayout.content : undefined;
  const approvalRows = approvalNotice
    ? measureApprovalPanelRows(approvalNotice, {
        diffExpanded: approvalDiffExpanded,
        wrapWidth: approvalPanelContentWidth(columns),
      })
    : 0;
  const genericDialogRows = dialogLayout.rows;
  const [expandedToolKey, setExpandedToolKey] = useState<string | null>(null);
  const mainEntries = useMemo(
    () => entries.filter((entry) => entry.kind !== "subagent-activity"),
    [entries],
  );
  const runtimeModelSummary = [
    modelRouteId ?? model,
    ...(!modelRouteId && provider ? [`provider ${provider}`] : []),
    ...(thinkingEffort ? [`think ${thinkingEffort}`] : []),
  ].join(" · ");
  const transcriptEntries = useMemo<TuiEntry[]>(
    () => [
      {
        kind: "logo",
        model: runtimeModelSummary,
        cwd: workDir,
      },
      ...mainEntries,
    ],
    [mainEntries, runtimeModelSummary, workDir],
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
  const maxVisibleAgentItems = Math.max(1, Math.min(4, rows - 12));
  const agentSwitcherRows = hasSubagents
    ? measureAgentSwitcherRows(navigationItems, maxVisibleAgentItems)
    : 0;
  const transcriptRows = Math.max(
    activeAgent ? 4 : inputDisabled ? 0 : 6,
    rows - 8 - genericDialogRows - transcriptLayout.approvalRows - agentSwitcherRows,
  );
  // 是否仍有"主动流式":running 且末尾是流式 assistant / thinking / running tool
  const isStreaming = running && isActivelyStreaming(mainEntries);
  // spinner 阶段:据末尾条目状态选
  const spinnerMode = pickSpinnerMode(mainEntries, isStreaming);
  const showSpinner = running && !inputDisabled && spinnerMode !== "responding";
  const focusedToolItem = transcriptLayout.items.find((item) => item.focusedTool);
  const focusedToolKey = focusedToolItem?.key ?? null;
  const focusedToolCallId =
    focusedToolItem?.entry.kind === "tool" ? focusedToolItem.entry.uiToolCallId : undefined;
  const focusedToolExpanded = focusedToolKey !== null && expandedToolKey === focusedToolKey;
  const inputDraft = useRef("");
  const [inputState, setInputState] = useState<InputBoxStateSnapshot>({
    text: "",
    hasSuggestions: false,
    historyIndex: null,
  });
  const handleInputStateChange = useCallback((snapshot: InputBoxStateSnapshot) => {
    inputDraft.current = snapshot.text;
    setInputState((current) =>
      current.text === snapshot.text &&
      current.hasSuggestions === snapshot.hasSuggestions &&
      current.historyIndex === snapshot.historyIndex
        ? current
        : snapshot,
    );
  }, []);
  const [transcriptView, setTranscriptView] = useState<TranscriptViewState>({ mode: "follow" });
  const previousEntries = useRef(mainEntries);
  const newMessageCount = transcriptView.mode === "manual" ? transcriptView.newMessageCount : 0;
  const transcriptViewportRows = transcriptContentRows(transcriptRows, {
    newMessageNotice: newMessageCount > 0,
    spinner: showSpinner,
  });
  const agentSwitcherLayout = buildAgentSwitcherLayout({
    items: navigationItems,
    selectedId: agentNavigation.selectedId,
    activeId: agentNavigation.activeId,
    focused: agentNavigation.focus === "picker",
    renderWidth: Math.max(1, columns - 2),
    maxVisibleItems: maxVisibleAgentItems,
  });

  useInput((input, key) => {
    const mouseInput = parseSgrMouseInput(input);
    if (
      hasSubagents &&
      focusedDialog === null &&
      mouseInput?.kind === "left-button" &&
      mouseInput.action === "press"
    ) {
      const switcherTopRow = rows - agentSwitcherLayout.totalRows + 1;
      const itemId = hitTestAgentSwitcherRow(agentSwitcherLayout, mouseInput.row - switcherTopRow);
      if (itemId) {
        setAgentNavigation((current) =>
          reduceAgentNavigation(current, { type: "open-item", id: itemId }, navigationItems),
        );
        return;
      }
    }

    const agentEvent = resolveAgentNavigationInput(input, key, {
      state: agentNavigation,
      inputState,
      hasSubagents,
      blocked:
        focusedDialog !== null || resolveAppKeyEvent(input, key, running, keybindings) !== null,
    });
    if (agentEvent) {
      setAgentNavigation((current) =>
        applyAgentNavigationInput(current, agentEvent, navigationItems),
      );
      return;
    }
    if (agentNavigation.focus === "picker" && isPrintableInput(input, key)) {
      setAgentNavigation((current) =>
        reduceAgentNavigation(current, { type: "focus-input" }, navigationItems),
      );
    }

    const owner = resolveAppInputOwner(input, key, {
      running,
      modal: inputDisabled,
      canToggleTool: focusedToolKey !== null,
      inputDraft: inputDraft.current,
      keybindings,
    });
    if (owner === "tool-card" && focusedToolKey) {
      if (focusedToolCallId && onInspectTool) {
        onInspectTool(focusedToolCallId);
        return;
      }
      if (focusedToolExpanded) {
        setExpandedToolKey(null);
        setTranscriptView({ mode: "follow" });
      } else {
        setExpandedToolKey(focusedToolKey);
        setTranscriptView({
          mode: "tool-anchor",
          toolKey: focusedToolKey,
          offsetRows: transcriptItemStartRow(transcriptLayout, focusedToolKey),
        });
      }
      return;
    }

    if (owner === "transcript") {
      if (mouseInput?.kind === "other") return;
      if (mouseInput?.kind === "left-button") return;
      const transcriptAction =
        mouseInput?.kind === "wheel"
          ? mouseInput.direction === "up"
            ? "wheelUp"
            : "wheelDown"
          : resolveTranscriptScrollKey(key);
      if (!transcriptAction) return;
      setTranscriptView((current) =>
        nextTranscriptView(current, transcriptAction, transcriptViewportRows, transcriptTotalRows),
      );
      return;
    }

    if (owner !== "global") return;
    const action = resolveAppKeyEvent(input, key, running, keybindings);
    if (action === "interrupt") {
      onInterrupt?.();
      return;
    }
    if (action === "redraw") {
      onRedraw?.();
      return;
    }
    if (action === "suspend") {
      mouseMode.disable();
      void suspendTerminal(suspendProcessUntilContinued)
        .then(() => mouseMode.enable())
        .catch((error: unknown) => exit(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (action === "exit") {
      onExit?.();
      exit();
    }
  });

  useEffect(() => {
    setAgentNavigation((current) => reconcileAgentNavigationState(current, navigationItems));
  }, [navigationItems]);

  useEffect(() => {
    if (!activeAgent) return;
    const count = activeAgent.timeline?.length ?? 0;
    setSeenTimelineCounts((current) =>
      current[activeAgent.id] === count ? current : { ...current, [activeAgent.id]: count },
    );
  }, [activeAgent]);

  useEffect(() => {
    setTranscriptView((current) => {
      if (current.mode === "follow") return current;
      const offsetRows = clampScrollRows(
        current.offsetRows,
        transcriptViewportRows,
        transcriptTotalRows,
      );
      if (
        current.mode === "manual" &&
        offsetRows >= maxTranscriptScroll(transcriptViewportRows, transcriptTotalRows)
      ) {
        return { mode: "follow" };
      }
      return offsetRows === current.offsetRows ? current : { ...current, offsetRows };
    });
  }, [transcriptTotalRows, transcriptViewportRows]);

  useEffect(() => {
    const previous = previousEntries.current;
    previousEntries.current = mainEntries;
    if (mainEntries === previous) return;
    const addedEntries = Math.max(0, mainEntries.length - previous.length);
    setTranscriptView((current) => {
      if (current.mode === "tool-anchor") return { mode: "follow" };
      if (current.mode !== "manual" || addedEntries === 0) return current;
      return { ...current, newMessageCount: current.newMessageCount + addedEntries };
    });
  }, [mainEntries]);

  useEffect(() => {
    setTranscriptView((current) => {
      if (current.mode !== "tool-anchor") return current;
      return expandedToolKey === current.toolKey && focusedToolKey === current.toolKey
        ? current
        : { mode: "follow" };
    });
  }, [expandedToolKey, focusedToolKey]);

  useEffect(() => {
    setApprovalDiffExpanded(true);
  }, [approvalNotice?.taskId]);

  // 诊断:记录每次渲染的 entries 状态
  dbg(workDir, `render: entries=${entries.length} running=${running} streaming=${isStreaming}`);
  mainEntries.forEach((e, i) => {
    const c = e.kind === "user" || e.kind === "assistant" ? e.content.slice(0, 40) : e.kind;
    dbg(workDir, `  [${i}] ${e.kind}: ${c}`);
  });

  const phase = approvalNotice
    ? "approval"
    : queuedCount > 0
      ? "queued"
      : running
        ? "running"
        : "idle";
  const runtimeTaskSummary = queuedCount > 0 ? `${queuedCount} queued` : taskSummary;
  const status = (
    <StatusBar
      phase={phase}
      sessionMode={sessionMode}
      permissionMode={permissionMode}
      mcpSummary={mcpSummary}
      contextSummary={undefined}
      taskSummary={runtimeTaskSummary}
      renderWidth={Math.max(1, columns - 2)}
    />
  );
  const transcript = (
    /* 消息列表和 spinner 共用固定高度容器，避免状态漂浮到视口底部。 */
    <Box flexDirection="column" height={transcriptRows} overflowY="hidden" paddingX={1}>
      {activeAgent ? (
        <AgentDetailView
          agent={activeAgent}
          renderWidth={transcriptWrapWidth}
          timelineLimit={Math.max(1, transcriptRows - 8)}
          visibleRows={transcriptRows}
        />
      ) : (
        <>
          {newMessageCount > 0 && <Text color="cyan">↓ {newMessageCount} new messages</Text>}
          <ToolCardFocusProvider expanded={focusedToolExpanded}>
            <MessageList
              layout={transcriptLayout}
              isStreaming={isStreaming}
              viewportRows={transcriptViewportRows}
              scrollOffsetRows={transcriptView.mode === "follow" ? 0 : transcriptView.offsetRows}
              estimatedRowHeight={3}
              overscanRows={0}
              virtualizeThreshold={0}
              scrollToBottom={transcriptView.mode === "follow"}
              preserveVirtualSpacers={false}
            />
          </ToolCardFocusProvider>
          {showSpinner && <Spinner mode={spinnerMode} />}
        </>
      )}
    </Box>
  );
  const bottom = (
    <Box flexDirection="column">
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
          disabledLabel={
            activeAgent ? "Viewing subagent · Esc back to Main" : "Use dialog controls"
          }
          acceptsInput={(input, key) => {
            const agentEvent = resolveAgentNavigationInput(input, key, {
              state: agentNavigation,
              inputState,
              hasSubagents,
              blocked:
                focusedDialog !== null ||
                resolveAppKeyEvent(input, key, running, keybindings) !== null,
            });
            if (agentEvent) return false;
            return (
              resolveAppInputOwner(input, key, {
                running,
                modal: inputDisabled,
                canToggleTool: focusedToolKey !== null,
                inputDraft: inputDraft.current,
                keybindings,
              }) === "input"
            );
          }}
          onTextChange={(text) => {
            inputDraft.current = text;
          }}
          onStateChange={handleInputStateChange}
          slashCommandSuggestions={slashCommandSuggestions}
          slashArgumentSuggestions={slashArgumentSuggestions}
          fileMentionSuggestions={fileMentionSuggestions}
          keybindings={keybindings}
          inputReplacement={inputReplacement}
          imagePasteShortcutLabel={imagePasteShortcutLabel}
          onSubmit={(submission) => {
            setTranscriptView({ mode: "follow" });
            setExpandedToolKey(null);
            onSubmit(submission);
          }}
        />
      </Box>
      {hasSubagents && (
        <Box paddingX={1}>
          <AgentSwitcher
            items={navigationItems}
            selectedId={agentNavigation.selectedId}
            activeId={agentNavigation.activeId}
            focused={agentNavigation.focus === "picker"}
            renderWidth={Math.max(1, columns - 2)}
            maxVisibleItems={maxVisibleAgentItems}
          />
        </Box>
      )}
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
      hidden={redrawBlank}
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

  const maxRows = Math.max(4, options.rows - 9);
  const width = Math.max(1, options.columns - 8);
  if (
    React.isValidElement<InteractiveHelpPanelProps>(content) &&
    content.type === InteractiveHelpPanel
  ) {
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

  if (React.isValidElement<AskUserDialogProps>(content) && content.type === AskUserDialog) {
    const maxQuestionLines = maxRows >= 8 ? 2 : 1;
    const fixedRows = 2 + maxQuestionLines;
    const optionCount = content.props.request.options.length;
    let maxVisibleOptions = Math.max(1, Math.min(3, optionCount, maxRows - fixedRows));
    const showOverflowHint = maxVisibleOptions < optionCount && maxRows - fixedRows >= 2;
    if (showOverflowHint) {
      maxVisibleOptions = Math.max(1, Math.min(maxVisibleOptions, maxRows - fixedRows - 1));
    }
    const renderedRows = fixedRows + maxVisibleOptions + (showOverflowHint ? 1 : 0);
    return {
      content: React.cloneElement(content, {
        maxVisibleOptions,
        maxQuestionLines,
        renderWidth: width,
        showOverflowHint,
      }),
      rows: renderedRows,
    };
  }

  if (
    React.isValidElement<InspectorDialogContentProps>(content) &&
    content.type === InspectorDialogContent
  ) {
    return {
      content: React.cloneElement(content, {
        visibleLines: Math.max(1, maxRows - 7),
        renderWidth: width,
        compact: maxRows <= 5,
      }),
      rows: maxRows,
    };
  }

  if (
    React.isValidElement<ChangesDialogContentProps>(content) &&
    content.type === ChangesDialogContent
  ) {
    const compact = maxRows <= 18;
    const tiny = maxRows <= 5;
    return {
      content: React.cloneElement(content, {
        compact,
        renderWidth: width,
        showPatch: !tiny || maxRows === 5,
        showWarnings: !tiny,
        maxVisibleFiles: compact ? 1 : Math.min(3, Math.max(1, maxRows - 10)),
        maxPatchLines: compact ? Math.max(1, maxRows - 7) : Math.max(1, maxRows - 14),
      }),
      rows: maxRows,
    };
  }

  return { content, rows: Math.min(maxRows, 5) };
}

export type AppGlobalAction = "interrupt" | "exit" | "redraw" | "suspend";
type TranscriptScrollAction =
  | "pageUp"
  | "pageDown"
  | "lineUp"
  | "lineDown"
  | "wheelUp"
  | "wheelDown"
  | "top"
  | "bottom";
type ToolCardAction = "toggle";
export type AppInputOwner = "global" | "modal" | "tool-card" | "transcript" | "input";

type TranscriptViewState =
  | { mode: "follow" }
  | { mode: "manual"; offsetRows: number; newMessageCount: number }
  | { mode: "tool-anchor"; toolKey: string; offsetRows: number };

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

type AgentNavigationInputAction = AgentNavigationEvent | { type: "focus-next" };

export function resolveAgentNavigationInput(
  _input: string,
  key: AppInputKey,
  options: {
    state: { focus: "input" | "picker"; activeId: string };
    inputState: InputBoxStateSnapshot;
    hasSubagents: boolean;
    blocked: boolean;
  },
): AgentNavigationInputAction | null {
  if (options.blocked || !options.hasSubagents) return null;
  if (options.state.activeId !== MAIN_AGENT_ID && key.escape) return { type: "escape" };

  if (options.state.focus === "picker") {
    if (key.upArrow) return { type: "move-up" };
    if (key.downArrow) return { type: "move-down" };
    if (key.return) return { type: "open" };
    if (key.tab) return { type: "focus-input" };
    if (key.escape) return { type: "escape" };
    return null;
  }

  if (options.inputState.text || options.inputState.hasSuggestions) return null;
  if (key.tab) return { type: "focus-picker" };
  // 空输入下的 ↓ 原本不会找到更新的历史，用它自然进入代理列表；
  // ↑ 仍保留给输入历史。
  if (key.downArrow && options.inputState.historyIndex === null) return { type: "focus-next" };
  return null;
}

function applyAgentNavigationInput(
  state: ReturnType<typeof createAgentNavigationState>,
  action: AgentNavigationInputAction,
  items: readonly AgentNavigationItem[],
): ReturnType<typeof createAgentNavigationState> {
  if (action.type !== "focus-next") return reduceAgentNavigation(state, action, items);
  const focused = reduceAgentNavigation(state, { type: "focus-picker" }, items);
  return reduceAgentNavigation(focused, { type: "move-down" }, items);
}

function isPrintableInput(input: string, key: AppInputKey): boolean {
  return (
    input.length > 0 &&
    !input.startsWith("[") &&
    !key.ctrl &&
    !key.meta &&
    !key.return &&
    !key.escape
  );
}

export function resolveAppInputOwner(
  input: string,
  key: AppInputKey,
  options: {
    running: boolean;
    modal: boolean;
    canToggleTool: boolean;
    inputDraft?: string;
    keybindings?: UserKeybindingConfig;
  },
): AppInputOwner {
  if (resolveAppKeyEvent(input, key, options.running, options.keybindings)) return "global";
  if (options.modal) return "modal";
  if (parseSgrMouseInput(input)) return "transcript";
  if (
    options.inputDraft &&
    resolveKeybinding({ input, key }, "Chat", options.keybindings) !== null
  ) {
    return "input";
  }
  if (resolveToolCardToggleKey(input, key, options.canToggleTool, false, options.keybindings)) {
    return "tool-card";
  }
  if (resolveTranscriptScrollKey(key)) return "transcript";
  return "input";
}

export function resolveAppKeyEvent(
  input: string,
  key: AppInputKey,
  running: boolean,
  keybindings?: UserKeybindingConfig,
): AppGlobalAction | null {
  if (input === "z" && key.ctrl) return "suspend";
  const resolved = resolveKeybinding({ input, key }, "Global", keybindings);
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

export function resolveTranscriptScrollKey(
  key: {
    ctrl?: boolean;
    shift?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    home?: boolean;
    end?: boolean;
  },
  blocked = false,
): TranscriptScrollAction | null {
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
  keybindings?: UserKeybindingConfig,
): ToolCardAction | null {
  if (!canToggle || blocked) return null;
  const resolved = resolveKeybinding({ input, key }, "Transcript", keybindings);
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
    case "wheelUp":
      return clampScrollRows(currentOffset - 3, viewportRows, totalRows);
    case "lineDown": {
      const next = clampScrollRows(currentOffset + 1, viewportRows, totalRows);
      return next >= maxScroll ? null : next;
    }
    case "wheelDown": {
      const next = clampScrollRows(currentOffset + 3, viewportRows, totalRows);
      return next >= maxScroll ? null : next;
    }
    case "top":
      return 0;
    case "bottom":
      return null;
  }
}

function nextTranscriptView(
  current: TranscriptViewState,
  action: TranscriptScrollAction,
  viewportRows: number,
  totalRows: number,
): TranscriptViewState {
  const currentOffset = current.mode === "follow" ? null : current.offsetRows;
  const offsetRows = nextTranscriptScroll(currentOffset, action, viewportRows, totalRows);
  if (offsetRows === null) return { mode: "follow" };
  if (offsetRows >= maxTranscriptScroll(viewportRows, totalRows)) return { mode: "follow" };
  return {
    mode: "manual",
    offsetRows,
    newMessageCount: current.mode === "manual" ? current.newMessageCount : 0,
  };
}

function clampScrollRows(offset: number, viewportRows: number, totalRows: number): number {
  return Math.min(Math.max(0, offset), maxTranscriptScroll(viewportRows, totalRows));
}

function maxTranscriptScroll(viewportRows: number, totalRows: number): number {
  return Math.max(0, totalRows - Math.max(1, viewportRows));
}

function transcriptItemStartRow(
  layout: ReturnType<typeof buildTranscriptLayout>,
  key: string,
): number {
  let rows = 0;
  for (const item of layout.items) {
    if (item.key === key) return rows;
    rows += item.rows;
  }
  return rows;
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
