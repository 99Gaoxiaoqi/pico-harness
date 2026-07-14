import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  ElicitationField,
  ElicitationRequestId,
  ElicitationUiRequest,
  McpElicitationUiHandler,
} from "../mcp/elicitation-ui.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { truncateTerminalText } from "./terminal-width.js";

const DIALOG_PREFIX = "mcp-elicitation:pending:";
const DIALOG_PRIORITY = 65;

export interface McpElicitationDialogHost {
  openDialog(request: DialogRequest): void;
  closeDialog(id: string): void;
}

export interface McpElicitationDialogProps {
  request: ElicitationUiRequest;
  onSubmit(values: Readonly<Record<string, unknown>>): void;
  onDecline(): void;
  onCancel(): void;
}

export function mcpElicitationDialogId(requestId: ElicitationRequestId): string {
  return `${DIALOG_PREFIX}${requestId}`;
}

export function createMcpElicitationDialogRequest(
  request: ElicitationUiRequest,
  handler: McpElicitationUiHandler,
): DialogRequest {
  return {
    id: mcpElicitationDialogId(request.requestId),
    layer: "modal",
    priority: DIALOG_PRIORITY,
    content: (
      <McpElicitationDialog
        request={request}
        onSubmit={(values) => handler.submit(request.requestId, values)}
        onDecline={() => handler.decline(request.requestId)}
        onCancel={() => handler.cancel(request.requestId)}
      />
    ),
  };
}

export function bindMcpElicitationDialogs(
  handler: McpElicitationUiHandler,
  host: McpElicitationDialogHost,
): () => void {
  const opened = new Set<string>();
  const open = (request: ElicitationUiRequest): void => {
    const id = mcpElicitationDialogId(request.requestId);
    if (opened.has(id)) return;
    opened.add(id);
    host.openDialog(createMcpElicitationDialogRequest(request, handler));
  };
  const close = (requestId: ElicitationRequestId): void => {
    const id = mcpElicitationDialogId(requestId);
    if (!opened.delete(id)) return;
    host.closeDialog(id);
  };
  const unsubscribe = handler.subscribe((event) => {
    if (event.kind === "pending") open(event.request);
    else close(event.request.requestId);
  });
  for (const request of handler.getPendingRequests()) open(request);
  return () => {
    unsubscribe();
    for (const id of opened) host.closeDialog(id);
    opened.clear();
  };
}

export function McpElicitationDialog({
  request,
  onSubmit,
  onDecline,
  onCancel,
}: McpElicitationDialogProps): React.ReactNode {
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(request.fields),
  );
  const field = request.fields[fieldIndex];
  const displayValue = useMemo(
    () => (field ? formatValue(field, values[field.key]) : "(无字段，仅需确认)"),
    [field, values],
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.ctrl && input.toLowerCase() === "d") {
      onDecline();
      return;
    }
    if (key.return) {
      try {
        onSubmit(values);
      } catch (submitError) {
        setError(submitError instanceof Error ? submitError.message : String(submitError));
      }
      return;
    }
    if (request.fields.length === 0) return;
    if (key.tab || key.downArrow) {
      setFieldIndex((current) => (current + 1) % request.fields.length);
      setError(undefined);
      return;
    }
    if (key.upArrow) {
      setFieldIndex((current) => (current - 1 + request.fields.length) % request.fields.length);
      setError(undefined);
      return;
    }
    if (!field) return;
    if (field.kind === "boolean") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setValues((current) => ({ ...current, [field.key]: current[field.key] !== true }));
      }
      return;
    }
    if (field.kind === "enum") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        const currentValue = values[field.key];
        const currentIndex = Math.max(
          0,
          field.values.findIndex((candidate) => candidate.value === currentValue),
        );
        const direction = key.leftArrow ? -1 : 1;
        const next = (currentIndex + direction + field.values.length) % field.values.length;
        setValues((current) => ({ ...current, [field.key]: field.values[next]!.value }));
      }
      return;
    }
    const rawCurrent = values[field.key];
    const current = typeof rawCurrent === "string" ? rawCurrent : "";
    if (key.backspace || key.delete) {
      setValues((all) => ({ ...all, [field.key]: current.slice(0, -1) }));
    } else if (!key.ctrl && !key.meta && input && !/\p{C}/u.test(input)) {
      const limit = field.kind === "string" ? field.maxLength : 64;
      setValues((all) => ({ ...all, [field.key]: `${current}${input}`.slice(0, limit) }));
    }
    setError(undefined);
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">MCP {request.server} 请求用户输入</Text>
      <Text>{truncateTerminalText(request.message, 100)}</Text>
      <Text>
        {field
          ? `[${fieldIndex + 1}/${request.fields.length}] ${field.title}${field.required ? " *" : ""}: ${displayValue}`
          : displayValue}
      </Text>
      <Text dimColor>↑/↓ 切换字段 · ←/→ 选项 · Enter 提交 · Ctrl-D 拒绝 · Esc 取消</Text>
      <Text color={error ? "red" : undefined}>{error ?? field?.description ?? " "}</Text>
    </Box>
  );
}

function initialValues(fields: readonly ElicitationField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue]));
}

function formatValue(field: ElicitationField, value: unknown): string {
  if (field.kind === "boolean") return value === true ? "true" : "false";
  if (field.kind === "enum") {
    return (
      field.values.find((candidate) => candidate.value === value)?.label ?? String(value ?? "")
    );
  }
  return String(value ?? "");
}
