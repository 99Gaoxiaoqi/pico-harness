import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalNotice } from "../approval/manager.js";
import type {
  PermissionRecentDenial,
  PermissionRule,
  PermissionState,
} from "../approval/permission-state.js";
import { resolveKeybinding } from "./keybindings/resolver.js";

const DEFAULT_DIFF_PREVIEW_LINES = 22;

export interface ApprovalPanelProps extends ApprovalNotice {
  diffExpanded?: boolean;
}
export interface PermissionPanelProps {
  state: PermissionState;
}
export type ApprovalPanelAction = "approve" | "approve-session" | "reject";
export type ApprovalPanelKeyAction = ApprovalPanelAction | "toggle-diff";
export interface ApprovalPanelState {
  diffExpanded: boolean;
}
export interface InteractiveApprovalPanelProps extends ApprovalPanelProps {
  onAction: (action: ApprovalPanelAction) => void;
}

export function InteractiveApprovalPanel({
  onAction,
  ...notice
}: InteractiveApprovalPanelProps): React.ReactNode {
  const [state, setState] = useState<ApprovalPanelState>(() => ({
    diffExpanded: notice.diffExpanded ?? false,
  }));

  useInput((input, key) => {
    const action = resolveApprovalPanelKey(input, key);
    if (!action) return;
    if (action === "toggle-diff") {
      setState((current) => nextApprovalPanelState(current, action));
      return;
    }
    onAction(action);
  });

  return <ApprovalPanel {...notice} diffExpanded={state.diffExpanded} />;
}

export function ApprovalPanel({
  diffExpanded = false,
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
      {formatApprovalPanel(notice, { diffExpanded })
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
  options: { diffExpanded?: boolean; includeDiff?: boolean; maxDiffPreviewLines?: number } = {},
): string {
  const target = notice.preview?.target ?? approvalTarget(notice.toolName, notice.args);
  const summary = notice.preview?.summary ?? approvalSummary(notice.message);
  const diff = notice.preview?.diff ?? notice.diff;
  const diffExpanded = options.diffExpanded ?? options.includeDiff ?? false;
  const lines = [
    `Approval required: ${notice.toolName}`,
    `目标: ${target}`,
    `摘要: ${summary}`,
    `任务: ${notice.taskId}`,
    `Enter/Y 允许一次 · A 本会话允许 · N/Esc 拒绝 · E 展开/折叠 diff`,
    `命令备用: approve ${notice.taskId} · reject ${notice.taskId} · modify ${notice.taskId} <content>`,
  ];
  if (diff) {
    lines.push(formatDiffSummary(diff, diffExpanded));
  }
  if (diffExpanded && diff) {
    lines.push(formatDiffPreview(diff, options.maxDiffPreviewLines));
  }
  return lines.join("\n");
}

export function resolveApprovalPanelKey(
  input: string,
  key: { return?: boolean; escape?: boolean; ctrl?: boolean; meta?: boolean },
): ApprovalPanelKeyAction | null {
  const resolved = resolveKeybinding({ input, key }, "Confirmation");
  if (resolved?.kind === "action" && resolved.action === "confirmation:accept") {
    return "approve";
  }
  if (resolved?.kind === "action" && resolved.action === "confirmation:cancel") {
    return "reject";
  }

  const normalized = input.toLowerCase();
  if (normalized === "a" && !key.ctrl && !key.meta) return "approve-session";
  if (normalized === "e" && !key.ctrl && !key.meta) return "toggle-diff";
  return null;
}

export function nextApprovalPanelState(
  state: ApprovalPanelState,
  action: ApprovalPanelKeyAction,
): ApprovalPanelState {
  if (action !== "toggle-diff") return state;
  return { ...state, diffExpanded: !state.diffExpanded };
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
