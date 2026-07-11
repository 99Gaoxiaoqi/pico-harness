import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { AskUserHandler, AskUserRequest, AskUserRequestId } from "../tools/ask-user.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { wrappedVisualRows } from "./terminal-width.js";

const ASK_USER_DIALOG_PREFIX = "ask-user:pending:";
export const ASK_USER_DIALOG_PRIORITY = 60;

export interface AskUserDialogState {
  readonly selectedIndex: number;
}

export type AskUserDialogAction = "move-up" | "move-down" | "select" | "cancel";

export interface AskUserDialogProps {
  readonly request: AskUserRequest;
  readonly selectedIndex?: number;
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
  onSelect,
  onCancel,
}: AskUserDialogProps): React.ReactNode {
  const [internalState, setInternalState] = useState<AskUserDialogState>({ selectedIndex: 0 });
  const submittedRequestId = useRef<AskUserRequestId | null>(null);
  const effectiveIndex = clampIndex(
    selectedIndex ?? internalState.selectedIndex,
    request.options.length,
  );

  useEffect(() => {
    submittedRequestId.current = null;
    setInternalState({ selectedIndex: 0 });
  }, [request.requestId]);

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
        setInternalState((current) =>
          nextAskUserDialogState(current, action, request.options.length),
        );
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
      {formatAskUserDialog(request, effectiveIndex)
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
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
