import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserHandler, AskUserRequest, AskUserRequestId } from "../tools/ask-user.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { truncateTerminalText, wrappedVisualRows } from "./terminal-width.js";

const ASK_USER_DIALOG_PREFIX = "ask-user:pending:";
export const ASK_USER_DIALOG_PRIORITY = 60;

export interface AskUserDialogState {
  readonly selectedIndex: number;
}

export type AskUserDialogAction = "move-up" | "move-down" | "select" | "cancel";

export interface AskUserDialogProps {
  readonly request: AskUserRequest;
  readonly selectedIndex?: number;
  readonly selectionState?: { selectedIndex: number };
  readonly maxVisibleOptions?: number;
  readonly maxQuestionLines?: number;
  readonly renderWidth?: number;
  readonly showOverflowHint?: boolean;
  readonly onSelect: (optionId: string) => void;
  readonly onCancel: () => void;
}

export interface AskUserDialogRequestOptions {
  readonly priority?: number;
  readonly onClose?: (dialogId: string) => void;
}

export interface AskUserDialogHost {
  readonly openDialog: (request: DialogRequest) => void;
  readonly closeDialog: (dialogId: string) => void;
}

export function askUserDialogId(requestId: AskUserRequestId): string {
  return `${ASK_USER_DIALOG_PREFIX}${requestId}`;
}

export function isAskUserDialogId(id: string): boolean {
  return id.startsWith(ASK_USER_DIALOG_PREFIX);
}

/**
 * 把 handler 的 pending request 转成 DialogArbiter 请求。
 * 宿主通常在 handler pending 事件中调用本函数，settled 事件中移除 dialog。
 */
export function createAskUserDialogRequest(
  request: AskUserRequest,
  handler: Pick<AskUserHandler, "select" | "cancel">,
  options: AskUserDialogRequestOptions = {},
): DialogRequest {
  const id = askUserDialogId(request.requestId);
  const selectionState = { selectedIndex: 0 };
  const closeIfSettled = (settled: boolean): void => {
    if (settled) options.onClose?.(id);
  };
  return {
    id,
    layer: "modal",
    priority: options.priority ?? ASK_USER_DIALOG_PRIORITY,
    content: (
      <AskUserDialog
        request={request}
        selectionState={selectionState}
        onSelect={(optionId) => {
          closeIfSettled(handler.select(request.requestId, optionId));
        }}
        onCancel={() => {
          closeIfSettled(handler.cancel(request.requestId));
        }}
      />
    ),
  };
}

/**
 * 可选宿主接线：handler 可先于 Ink 挂载，binding 会补展示已 pending 的问题。
 * 解绑只关闭本 UI 打开的 dialog，不取消工具请求，便于 Session 热切换后重新绑定。
 */
export function bindAskUserDialogs(handler: AskUserHandler, host: AskUserDialogHost): () => void {
  const openedDialogIds = new Set<string>();
  const open = (request: AskUserRequest): void => {
    const id = askUserDialogId(request.requestId);
    if (openedDialogIds.has(id)) return;
    openedDialogIds.add(id);
    host.openDialog(createAskUserDialogRequest(request, handler));
  };
  const close = (requestId: AskUserRequestId): void => {
    const id = askUserDialogId(requestId);
    if (!openedDialogIds.delete(id)) return;
    host.closeDialog(id);
  };

  const unsubscribe = handler.subscribe((event) => {
    if (event.kind === "pending") open(event.request);
    else close(event.request.requestId);
  });
  for (const request of handler.getPendingRequests()) open(request);

  return () => {
    unsubscribe();
    for (const id of openedDialogIds) host.closeDialog(id);
    openedDialogIds.clear();
  };
}

export function AskUserDialog({
  request,
  selectedIndex,
  selectionState,
  maxVisibleOptions = 3,
  maxQuestionLines = 2,
  renderWidth = 80,
  showOverflowHint = true,
  onSelect,
  onCancel,
}: AskUserDialogProps): React.ReactNode {
  const [internalState, setInternalState] = useState<AskUserDialogState>(() => ({
    selectedIndex: selectionState?.selectedIndex ?? 0,
  }));
  const submittedRequestId = useRef<AskUserRequestId | null>(null);
  const effectiveIndex = clampIndex(
    selectedIndex ?? selectionState?.selectedIndex ?? internalState.selectedIndex,
    request.options.length,
  );

  useEffect(() => {
    submittedRequestId.current = null;
    const restoredIndex = selectionState?.selectedIndex ?? 0;
    setInternalState({ selectedIndex: restoredIndex });
  }, [request.requestId, selectionState]);

  useInput((input, key) => {
    const numberedIndex = resolveNumberedOption(input, request.options.length);
    if (numberedIndex !== null) {
      submitOption(numberedIndex);
      return;
    }

    const action = resolveAskUserDialogKey(input, key);
    if (!action) return;
    if (action === "move-up" || action === "move-down") {
      if (selectedIndex === undefined) {
        if (selectionState) {
          const next = nextAskUserDialogState(
            { selectedIndex: selectionState.selectedIndex },
            action,
            request.options.length,
          );
          selectionState.selectedIndex = next.selectedIndex;
          setInternalState(next);
        } else {
          setInternalState((current) =>
            nextAskUserDialogState(current, action, request.options.length),
          );
        }
      }
      return;
    }
    if (action === "cancel") {
      if (submittedRequestId.current === request.requestId) return;
      submittedRequestId.current = request.requestId;
      onCancel();
      return;
    }
    submitOption(effectiveIndex);
  });

  function submitOption(index: number): void {
    if (submittedRequestId.current === request.requestId) return;
    const option = request.options[index];
    if (!option) return;
    submittedRequestId.current = request.requestId;
    onSelect(option.optionId);
  }

  return (
    <Box flexDirection="column">
      {formatAskUserDialogViewport(request, effectiveIndex, {
        maxVisibleOptions,
        maxQuestionLines,
        renderWidth,
        showOverflowHint,
      })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

function formatAskUserDialogViewport(
  request: AskUserRequest,
  selectedIndex: number,
  options: {
    maxVisibleOptions: number;
    maxQuestionLines: number;
    renderWidth: number;
    showOverflowHint: boolean;
  },
): string {
  const width = Math.max(1, Math.floor(options.renderWidth));
  const safeIndex = clampIndex(selectedIndex, request.options.length);
  const questionRows = wrappedVisualRows(request.question, width);
  const visibleQuestionRows = questionRows.slice(0, Math.max(1, options.maxQuestionLines));
  if (visibleQuestionRows.length < questionRows.length) {
    const last = visibleQuestionRows.length - 1;
    visibleQuestionRows[last] = truncateTerminalText(`${visibleQuestionRows[last] ?? ""}…`, width);
  }
  const optionCount = request.options.length;
  const windowSize = Math.min(optionCount, Math.max(1, Math.floor(options.maxVisibleOptions)));
  const start = Math.min(
    Math.max(0, safeIndex - Math.floor(windowSize / 2)),
    Math.max(0, optionCount - windowSize),
  );
  const lines = [
    truncateTerminalText(request.header ? `? ${request.header}` : "? Question", width),
    ...visibleQuestionRows,
  ];
  for (let index = start; index < start + windowSize; index++) {
    const option = request.options[index];
    if (!option) continue;
    const marker = index === safeIndex ? "❯" : " ";
    const description = option.description ? ` — ${option.description}` : "";
    lines.push(
      truncateTerminalText(`${marker} ${index + 1}. ${option.label}${description}`, width),
    );
  }
  if (options.showOverflowHint && windowSize < optionCount) {
    lines.push(truncateTerminalText(`… ${optionCount - windowSize} option(s) outside view`, width));
  }
  lines.push(truncateTerminalText("↑/↓ move · Enter/number select · Esc cancel", width));
  return lines.join("\n");
}

export function formatAskUserDialog(request: AskUserRequest, selectedIndex = 0): string {
  const safeIndex = clampIndex(selectedIndex, request.options.length);
  const lines = [request.header ? `? ${request.header}` : "? Question", request.question];
  for (const [index, option] of request.options.entries()) {
    const marker = index === safeIndex ? "❯" : " ";
    const description = option.description ? ` — ${option.description}` : "";
    lines.push(`${marker} ${index + 1}. ${option.label}${description}`);
  }
  lines.push("↑/↓ or J/K to move · Enter or number to select · Esc to cancel");
  return lines.join("\n");
}

export function measureAskUserDialogRows(request: AskUserRequest, wrapWidth: number): number {
  return formatAskUserDialog(request)
    .split("\n")
    .reduce((total, line) => total + wrappedVisualRows(line, Math.max(1, wrapWidth)).length, 0);
}

export function resolveAskUserDialogKey(
  input: string,
  key: {
    readonly return?: boolean;
    readonly escape?: boolean;
    readonly upArrow?: boolean;
    readonly downArrow?: boolean;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
  },
): AskUserDialogAction | null {
  if (key.escape) return "cancel";
  if (key.return && !key.ctrl && !key.meta) return "select";
  if (key.upArrow || (input.toLocaleLowerCase() === "k" && !key.ctrl && !key.meta)) {
    return "move-up";
  }
  if (key.downArrow || (input.toLocaleLowerCase() === "j" && !key.ctrl && !key.meta)) {
    return "move-down";
  }
  return null;
}

export function nextAskUserDialogState(
  state: AskUserDialogState,
  action: AskUserDialogAction,
  optionCount: number,
): AskUserDialogState {
  if (optionCount <= 0 || (action !== "move-up" && action !== "move-down")) return state;
  if (action === "move-up") {
    return { selectedIndex: (state.selectedIndex + optionCount - 1) % optionCount };
  }
  return { selectedIndex: (state.selectedIndex + 1) % optionCount };
}

function resolveNumberedOption(input: string, optionCount: number): number | null {
  if (!/^\d$/u.test(input)) return null;
  const index = Number.parseInt(input, 10) - 1;
  return index >= 0 && index < optionCount ? index : null;
}

function clampIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), optionCount - 1);
}
