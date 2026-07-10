import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalNotice } from "../approval/manager.js";
import { formatPermissionSessionScope } from "../approval/session-permissions.js";
import type {
  PermissionRecentDenial,
  PermissionRule,
  PermissionState,
} from "../approval/permission-state.js";
import { resolveKeybinding, type UserKeybindingConfig } from "./keybindings/resolver.js";
import { wrappedVisualRows } from "./terminal-width.js";

const DEFAULT_DIFF_PREVIEW_LINES = 22;
const LAYOUT_SHELL_HORIZONTAL_PADDING = 2;
const APPROVAL_PANEL_HORIZONTAL_PADDING = 2;
const APPROVAL_DIALOG_PREFIX = "approval:pending:";

export function approvalDialogId(taskId: string): string {
  return `${APPROVAL_DIALOG_PREFIX}${taskId}`;
}

export function isApprovalDialogId(id: string): boolean {
  return id.startsWith(APPROVAL_DIALOG_PREFIX);
}

export interface ApprovalPanelProps extends ApprovalNotice {
  diffExpanded?: boolean;
  selectedIndex?: number;
}
export interface PermissionPanelProps {
  state: PermissionState;
}
export type ApprovalPanelAction = "approve" | "approve-session" | "reject";
export type ApprovalPanelKeyAction = ApprovalPanelAction | "toggle-diff" | "move-up" | "move-down";
export interface ApprovalPanelState {
  diffExpanded: boolean;
  selectedIndex: number;
}
export interface InteractiveApprovalPanelProps extends ApprovalPanelProps {
  onAction: (action: ApprovalPanelAction) => void;
  onDiffExpandedChange?: (expanded: boolean) => void;
  keybindings?: UserKeybindingConfig;
}

export function InteractiveApprovalPanel({
  onAction,
  onDiffExpandedChange,
  diffExpanded,
  keybindings,
  ...notice
}: InteractiveApprovalPanelProps): React.ReactNode {
  const [state, setState] = useState<ApprovalPanelState>(() => ({
    diffExpanded: diffExpanded ?? Boolean(notice.diff ?? notice.preview?.diff),
    selectedIndex: 0,
  }));
  const submittedTaskId = useRef<string | null>(null);
  const expanded = diffExpanded ?? state.diffExpanded;
  const optionCount = notice.sessionScope ? 3 : 2;

  useInput((input, key) => {
    const action = resolveApprovalPanelKey(
      input,
      key,
      keybindings,
      state.selectedIndex,
      notice.sessionScope !== undefined,
    );
    if (!action) return;
    if (action === "move-up" || action === "move-down") {
      setState((current) => nextApprovalPanelState(current, action, optionCount));
      return;
    }
    if (action === "toggle-diff") {
      const nextExpanded = !expanded;
      if (diffExpanded === undefined) {
        setState((current) => ({ ...current, diffExpanded: nextExpanded }));
      }
      onDiffExpandedChange?.(nextExpanded);
      return;
    }
    if (submittedTaskId.current === notice.taskId) return;
    submittedTaskId.current = notice.taskId;
    onAction(action);
  });

  return <ApprovalPanel {...notice} diffExpanded={expanded} selectedIndex={state.selectedIndex} />;
}

export function ApprovalPanel({
  diffExpanded = false,
  selectedIndex = 0,
  ...notice
}: ApprovalPanelProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="yellow"
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      paddingX={1}
    >
      {formatApprovalPanel(notice, { diffExpanded, selectedIndex })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function PermissionPanel({ state }: PermissionPanelProps): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {formatPermissionPanel(state)
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function formatApprovalPanel(
  notice: ApprovalNotice,
  options: {
    diffExpanded?: boolean;
    includeDiff?: boolean;
    maxDiffPreviewLines?: number;
    selectedIndex?: number;
  } = {},
): string {
  const target = notice.preview?.target ?? approvalTarget(notice.toolName, notice.args);
  const summary = notice.preview?.summary ?? approvalSummary(notice.message);
  const diff = notice.preview?.diff ?? notice.diff;
  const diffExpanded = options.diffExpanded ?? options.includeDiff ?? Boolean(diff);
  const hasSessionOption = notice.sessionScope !== undefined;
  const approvalOptions: Array<{ label: string; action: ApprovalPanelAction }> = [
    { label: "Yes", action: "approve" },
    ...(hasSessionOption
      ? [
          {
            label: formatPermissionSessionScope(notice.sessionScope!),
            action: "approve-session" as const,
          },
        ]
      : []),
    { label: "No", action: "reject" },
  ];
  const selectedIndex = clampSelection(options.selectedIndex ?? 0, approvalOptions.length);
  const lines = [approvalQuestion(notice.toolName, target), `  ${target}`];
  if (diffExpanded && diff) {
    lines.push(formatDiffPreview(diff, options.maxDiffPreviewLines));
  } else if (diff) {
    lines.push(formatDiffSummary(diff, false));
  }
  if (!diff && summary !== target) lines.push(`  ${summary}`);
  lines.push(
    ...approvalOptions.map(
      (option, index) => `${index === selectedIndex ? "❯" : " "} ${index + 1}. ${option.label}`,
    ),
    "  ↑/↓ or J/K to move · Enter to select · Esc to cancel · E to toggle diff",
  );
  return lines.join("\n");
}

export function measureApprovalPanelRows(
  notice: ApprovalNotice,
  options: { diffExpanded: boolean; wrapWidth: number },
): number {
  const contentRows = formatApprovalPanel(notice, { diffExpanded: options.diffExpanded })
    .split("\n")
    .reduce(
      (total, line) => total + wrappedVisualRows(line, Math.max(1, options.wrapWidth)).length,
      0,
    );
  return 1 + contentRows;
}

export function approvalPanelContentWidth(terminalColumns: number): number {
  const columns = Number.isFinite(terminalColumns) ? Math.floor(terminalColumns) : 80;
  return Math.max(1, columns - LAYOUT_SHELL_HORIZONTAL_PADDING - APPROVAL_PANEL_HORIZONTAL_PADDING);
}

export function resolveApprovalPanelKey(
  input: string,
  key: { return?: boolean; escape?: boolean; ctrl?: boolean; meta?: boolean },
  keybindings?: UserKeybindingConfig,
  selectedIndex = 0,
  hasSessionOption = true,
): ApprovalPanelKeyAction | null {
  const arrowKey = key as typeof key & { upArrow?: boolean; downArrow?: boolean };
  if (arrowKey.upArrow || (input.toLowerCase() === "k" && !key.ctrl && !key.meta)) return "move-up";
  if (arrowKey.downArrow || (input.toLowerCase() === "j" && !key.ctrl && !key.meta))
    return "move-down";
  const normalized = input.toLowerCase();
  if (key.return && !key.ctrl && !key.meta) {
    return actionAtSelection(selectedIndex, hasSessionOption);
  }
  if (key.escape) return "reject";
  if (normalized === "y" && !key.ctrl && !key.meta) return "approve";
  if (normalized === "a" && !key.ctrl && !key.meta) {
    return hasSessionOption ? "approve-session" : null;
  }
  if (normalized === "n" && !key.ctrl && !key.meta) return "reject";
  const resolved = resolveKeybinding({ input, key }, "Confirmation", keybindings);
  if (resolved?.kind === "action" && resolved.action === "confirmation:accept") {
    return "approve";
  }
  if (resolved?.kind === "action" && resolved.action === "confirmation:cancel") {
    return "reject";
  }

  if (normalized === "e" && !key.ctrl && !key.meta) return "toggle-diff";
  return null;
}

export function nextApprovalPanelState(
  state: ApprovalPanelState,
  action: ApprovalPanelKeyAction,
  optionCount = 3,
): ApprovalPanelState {
  if (action === "toggle-diff") return { ...state, diffExpanded: !state.diffExpanded };
  if (action === "move-up") {
    return { ...state, selectedIndex: (state.selectedIndex + optionCount - 1) % optionCount };
  }
  if (action === "move-down") {
    return { ...state, selectedIndex: (state.selectedIndex + 1) % optionCount };
  }
  return state;
}

export function formatDiffSummary(diff: string, expanded = false): string {
  const lines = diff.split("\n");
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return `Diff: +${added} -${removed} (${lines.length} 行, ${expanded ? "已展开预览" : "已折叠"})`;
}

export function formatDiffPreview(diff: string, maxLines = DEFAULT_DIFF_PREVIEW_LINES): string {
  const lines = diff.split("\n");
  const visible = lines.slice(0, Math.max(0, maxLines));
  const hidden = Math.max(0, lines.length - visible.length);
  const suffix = hidden > 0 ? [`... 已隐藏 ${hidden} 行`] : [];
  return ["Diff preview:", ...visible, ...suffix].join("\n");
}

export function formatPermissionPanel(state: PermissionState): string {
  const lines = ["[Permissions]", `Mode: ${state.mode}`];
  const ruleLines = [
    ...formatRuleGroup("Allow", state.rules.allow),
    ...formatRuleGroup("Ask", state.rules.ask),
    ...formatRuleGroup("Deny", state.rules.deny),
  ];

  if (ruleLines.length === 0) {
    lines.push("No permission rules configured.");
  } else {
    lines.push(...ruleLines);
  }

  lines.push("Recent denials");
  if (state.recentDenials.length === 0) {
    lines.push("No recent denials.");
  } else {
    lines.push(...state.recentDenials.map(formatRecentDenial));
  }

  return lines.join("\n");
}

export function approvalTarget(toolName: string, args: string): string {
  const parsed = parseArgs(args);
  if (parsed) {
    const keys =
      toolName === "bash"
        ? ["command", "path", "file", "url", "query"]
        : ["path", "file", "command", "url", "query"];
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return compact(value.trim(), 160);
    }
  }
  return compact(args, 160);
}

function approvalSummary(message: string): string {
  return compact(message.replace(/\s+/gu, " ").trim() || "需要审批", 160);
}

function parseArgs(args: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function formatRuleGroup(title: string, rules: readonly PermissionRule[]): string[] {
  if (rules.length === 0) return [];
  return [title, ...rules.map((rule) => `- ${formatPermissionRule(rule)}`)];
}

function formatPermissionRule(rule: PermissionRule): string {
  const subject = [rule.tool, rule.pattern].filter(Boolean).join(" ") || rule.label;
  return rule.reason ? `${subject} - ${rule.reason}` : subject;
}

function formatRecentDenial(denial: PermissionRecentDenial): string {
  const prefix = [denial.deniedAt, denial.tool, denial.target].filter(Boolean).join(" ");
  return denial.reason ? `- ${prefix} - ${denial.reason}` : `- ${prefix}`;
}

function compact(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function actionAtSelection(index: number, hasSessionOption: boolean): ApprovalPanelAction {
  const actions: readonly ApprovalPanelAction[] = hasSessionOption
    ? ["approve", "approve-session", "reject"]
    : ["approve", "reject"];
  return actions[clampSelection(index, actions.length)]!;
}

function clampSelection(index: number, optionCount: number): number {
  return Math.max(0, Math.min(optionCount - 1, Math.floor(index)));
}

function approvalQuestion(toolName: string, target: string): string {
  const name = target.split(/[\\/]/u).at(-1) ?? target;
  if (toolName === "edit_file") return `Do you want to make this edit to ${name}?`;
  if (toolName === "write_file") return `Do you want to write to ${name}?`;
  if (toolName === "read_file") return `Do you want to read ${name}?`;
  if (toolName === "bash") return "Do you want to execute this command?";
  return `Do you want to allow ${toolName}?`;
}
