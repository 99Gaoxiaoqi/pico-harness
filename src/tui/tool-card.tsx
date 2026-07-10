// 工具调用卡片:对标 Claude Code 的 AgentProgressLine(树形缩进 + 状态 + 参数着色)
// + 工具结果折叠(默认一行摘要,按 e 展开)。
//
// 渲染要点:
//   折叠态:⎿ <name> · <状态> · <结果摘要>       (一行,默认)
//   展开态:⎿ <name> · <状态>                   (首行)
//            参数 <截断后参数>
//            结果 <完整 summary>
//
// 折叠/展开:由 App 顶层焦点所有者统一处理,工具卡片只消费受控状态。
//
// buildToolCardVisualRows 是布局与渲染的唯一视觉行来源,便于虚拟窗口从卡片内部裁剪。

import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";
import { formatOutputPreview } from "./diff-preview.js";
import { compactText, compactToolName, summarizeToolTarget } from "./tool-format.js";
import { terminalWidth, truncateTerminalText, visualRows } from "./terminal-width.js";

export type ToolCardStatus =
  | "queued"
  | "running"
  | "approval"
  | "success"
  | "error"
  | "denied"
  // Legacy aliases accepted at the view boundary while reporters migrate.
  | "done"
  | "failed";

const ToolCardExpansionContext = createContext(false);

export function ToolCardFocusProvider({
  expanded,
  children,
}: {
  expanded: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <ToolCardExpansionContext.Provider value={expanded}>
      {children}
    </ToolCardExpansionContext.Provider>
  );
}

export interface ToolCardProps {
  name: string;
  args: string;
  status: ToolCardStatus;
  summary?: string;
  /** 是否为消息列表中最后一条:决定树形符号 */
  isLast?: boolean;
  /** 初始展开状态;未传时默认折叠 */
  initialExpanded?: boolean;
  /** 与 transcript layout 一致的可用宽度 */
  wrapWidth?: number;
  /** 虚拟窗口从工具卡内部跳过的行数 */
  startOffsetRows?: number;
  /** 虚拟窗口在本工具卡内保留的行数 */
  visibleRows?: number;
}

export type ToolCardVisualRowKind = "header" | "args" | "result-label" | "result";

export interface ToolCardVisualRow {
  kind: ToolCardVisualRowKind;
  text: string;
}

export interface BuildToolCardVisualRowsOptions {
  name: string;
  args: string;
  status: ToolCardStatus;
  summary?: string;
  isLast: boolean;
  expanded: boolean;
  wrapWidth: number;
  canToggle?: boolean;
}

export function ToolCard(props: ToolCardProps): React.ReactNode {
  const {
    name,
    args,
    status,
    summary,
    isLast = false,
    initialExpanded,
    wrapWidth = 80,
    startOffsetRows = 0,
    visibleRows,
  } = props;
  const focusedExpanded = useContext(ToolCardExpansionContext);
  const canToggle = isLast || initialExpanded !== undefined;
  const expanded = canToggle && (initialExpanded ?? focusedExpanded);
  const rows = buildToolCardVisualRows({
    name,
    args,
    status,
    summary,
    isLast,
    expanded,
    wrapWidth,
    canToggle,
  });
  const start = Math.max(0, Math.floor(startOffsetRows));
  const end = visibleRows === undefined ? undefined : start + Math.max(0, Math.ceil(visibleRows));
  const visible = rows.slice(start, end);
  const failed = isFailureStatus(status);

  return (
    <Box flexDirection="column" marginLeft={isAgentToolName(name) ? 1 : 2}>
      {visible.map((row, index) => (
        <Text
          key={`${start + index}:${row.kind}:${row.text}`}
          color={
            row.kind === "header" ? "cyan" : failed && row.kind === "result" ? "red" : undefined
          }
          dimColor={row.kind !== "header" && !(failed && row.kind === "result")}
          wrap="truncate"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}

export function buildToolCardVisualRows(
  options: BuildToolCardVisualRowsOptions,
): ToolCardVisualRow[] {
  return isAgentToolName(options.name)
    ? buildAgentToolVisualRows(options)
    : buildStandardToolVisualRows(options);
}

function buildStandardToolVisualRows(options: BuildToolCardVisualRowsOptions): ToolCardVisualRow[] {
  const { name, args, status, summary, expanded, wrapWidth } = options;
  const canToggle = options.canToggle ?? options.isLast;
  const target = summarizeToolTarget(name, args, 30);
  const grouped = args.includes('"groupedCount"');
  const failure = isFailureStatus(status);
  const displaySummary = summary && failure ? ensureErrorSummary(summary) : summary;
  const resultBadge =
    displaySummary && (failure || grouped || !target)
      ? toolResultBadge(displaySummary, failure)
      : undefined;
  const availableHeaderWidth = Math.max(1, Math.floor(wrapWidth) - 2);
  const header = buildPrioritizedHeader({
    prefix: "⎿ ",
    name: compactToolName(name),
    status: toolStatusText(status),
    showToggle: canToggle,
    optionalParts: [target, resultBadge],
    availableWidth: availableHeaderWidth,
  });
  const rows: ToolCardVisualRow[] = [{ kind: "header", text: header }];
  if (!expanded) return rows;

  const detailWidth = Math.max(1, Math.floor(wrapWidth) - 4);
  rows.push(
    ...visualRows(`参数 ${formatToolArgsText(args)}`, detailWidth).map((text) => ({
      kind: "args" as const,
      text: `  ${text}`,
    })),
  );
  if (!displaySummary) return rows;
  rows.push({ kind: "result-label", text: "  结果" });
  rows.push(
    ...visualRows(toolResultPreview(displaySummary, true), detailWidth).map((text) => ({
      kind: "result" as const,
      text: `  ${text}`,
    })),
  );
  return rows;
}

function buildAgentToolVisualRows(options: BuildToolCardVisualRowsOptions): ToolCardVisualRow[] {
  const { name, args, status, summary, isLast, expanded, wrapWidth } = options;
  const canToggle = options.canToggle ?? isLast;
  const treeChar = isLast ? "└─" : "├─";
  const meta = agentToolMeta(name, args);
  const resultText = status === "running" ? meta.task : agentResultText(status, summary);
  const preview = agentResultHint(resultText);
  const availableHeaderWidth = Math.max(1, Math.floor(wrapWidth) - 1);
  const rows: ToolCardVisualRow[] = [
    {
      kind: "header",
      text: buildPrioritizedHeader({
        prefix: `${treeChar} `,
        name: meta.label,
        status: toolStatusText(status),
        showToggle: canToggle,
        optionalParts: [meta.detail ? `(${meta.detail})` : undefined, preview],
        availableWidth: availableHeaderWidth,
      }),
    },
  ];
  if (!expanded) return rows;

  const detailWidth = Math.max(1, Math.floor(wrapWidth) - 5);
  rows.push(
    ...visualRows(`参数 ${formatToolArgsText(args)}`, detailWidth).map((text) => ({
      kind: "args" as const,
      text: `   ${text}`,
    })),
    ...visualRows(`结果 ${resultText}`, detailWidth).map((text) => ({
      kind: "result" as const,
      text: `   ${text}`,
    })),
  );
  return rows;
}

function buildPrioritizedHeader(options: {
  prefix: string;
  name: string;
  status: string;
  showToggle: boolean;
  optionalParts: Array<string | undefined>;
  availableWidth: number;
}): string {
  const toggle = options.showToggle ? " [⌃E]" : "";
  const suffix = ` · ${options.status}${toggle}`;
  const nameBudget = Math.max(
    1,
    options.availableWidth - terminalWidth(options.prefix) - terminalWidth(suffix),
  );
  const name = truncateTerminalText(options.name, nameBudget);
  let header = `${options.prefix}${name}`;
  let remaining = Math.max(
    0,
    options.availableWidth - terminalWidth(header) - terminalWidth(suffix),
  );

  for (const part of options.optionalParts) {
    if (!part || remaining <= 4) continue;
    const value = truncateTerminalText(part, remaining - 3);
    header += ` · ${value}`;
    remaining = Math.max(0, remaining - 3 - terminalWidth(value));
  }

  return `${header}${suffix}`;
}

export function isAgentToolName(name: string): boolean {
  return (
    name === "spawn_subagent" ||
    name === "delegate_task" ||
    name === "delegate_status" ||
    name.startsWith("[Subagent]")
  );
}

function agentToolMeta(
  name: string,
  args: string,
): {
  label: string;
  detail?: string;
  task: string;
  color: "cyan" | "magenta";
} {
  const parsed = parseArgs(args);

  if (name.startsWith("[Subagent]")) {
    return {
      label: "Subagent",
      detail: name.replace(/^\[Subagent\]\s*/, "") || undefined,
      task: firstString(parsed, ["path", "command", "query", "task_prompt", "goal"]) ?? "Working…",
      color: "magenta",
    };
  }

  if (name === "delegate_task") {
    const batch = delegateBatchMeta(parsed);
    return {
      label: "Agents",
      detail: firstString(parsed, ["agent_name", "mode"]) ?? batch?.detail,
      task:
        batch?.task ?? firstString(parsed, ["goal", "task", "description"]) ?? "Delegating tasks…",
      color: "cyan",
    };
  }

  if (name === "delegate_status") {
    return {
      label: "Agents",
      detail: "status",
      task: firstString(parsed, ["delegationId", "delegation_id"]) ?? "Checking progress…",
      color: "cyan",
    };
  }

  return {
    label: "Agent",
    detail: firstString(parsed, ["agent_name", "mode"]),
    task:
      firstString(parsed, ["task_prompt", "goal", "task", "description"]) ?? "Starting subagent…",
    color: "cyan",
  };
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === "string" && raw.trim()) return compactText(raw.trim(), 88);
  }
  return undefined;
}

function delegateBatchMeta(value: unknown): { detail: string; task: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tasks = (value as Record<string, unknown>)["tasks"];
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  const firstTask = tasks.find((task) => task && typeof task === "object" && !Array.isArray(task));
  const firstGoal =
    firstTask && typeof firstTask === "object"
      ? firstString(firstTask, ["goal", "task", "description"])
      : undefined;
  return {
    detail: `${tasks.length} agents`,
    task: compactText(`1/${tasks.length} queued${firstGoal ? ` · ${firstGoal}` : ""}`, 96),
  };
}

function agentResultText(status: ToolCardStatus, summary: string | undefined): string {
  if (isFailureStatus(status)) return summary ? compactText(summary, 110) : "Subagent failed";
  return summary ? compactText(summary, 110) : "Success";
}

function toolStatusText(status: ToolCardStatus): string {
  const normalized = normalizeStatus(status);
  if (normalized === "queued") return "Queued";
  if (normalized === "running") return "Running";
  if (normalized === "approval") return "Approval";
  if (normalized === "denied") return "Denied";
  if (normalized === "error") return "Error";
  return "Success";
}

function agentResultHint(summary: string): string {
  return compactText(summary, 24);
}

function normalizeStatus(
  status: ToolCardStatus,
): "queued" | "running" | "approval" | "success" | "error" | "denied" {
  if (status === "done") return "success";
  if (status === "failed") return "error";
  return status;
}

function isFailureStatus(status: ToolCardStatus): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "error" || normalized === "denied";
}

function toolResultPreview(summary: string, expanded: boolean): string {
  const preview = formatOutputPreview(summary, { maxLines: expanded ? 5 : 1, expanded });
  return expanded ? preview : compactText(preview, 120);
}

function toolResultBadge(summary: string, failure = false): string {
  if (failure) return compactText(summary, 44);

  const grouped = summary.match(/^\d+ calls\s*·\s*([^·]+)/);
  if (grouped?.[1]) return compactText(grouped[1], 24);

  const preview = formatOutputPreview(summary, { maxLines: 1 });
  const compactedPreview = compactText(preview, 24);
  if (preview.includes("已截断") && compactedPreview.includes("已截断")) return compactedPreview;
  if (preview.includes("已截断") && !compactedPreview.includes("已截断")) {
    const firstLine = compactText(summary.split("\n").find((line) => line.trim()) ?? summary, 18);
    return `${firstLine} · 已截断`;
  }

  const first = summary
    .split("·")
    .map((part) => part.trim())
    .find(Boolean);
  return compactText(first ?? compactedPreview, 24);
}

export function formatErrorSummary(error: string): string {
  const firstUsefulLine = error
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return `可复制错误: ${compactText(firstUsefulLine ?? error, 166)}`;
}

function ensureErrorSummary(error: string): string {
  return error.startsWith("可复制错误:") ? error : formatErrorSummary(error);
}

function formatToolArgsText(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const text = JSON.stringify(parsed) ?? trimmed;
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }

  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      const text = raw && raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
      return `${key}:${text ?? ""}`;
    })
    .join(" ");
}
