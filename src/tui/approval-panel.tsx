import React from "react";
import { Box, Text } from "ink";
import type { ApprovalNotice } from "../approval/manager.js";
import type {
  PermissionRecentDenial,
  PermissionRule,
  PermissionState,
} from "../approval/permission-state.js";
import { DiffPreview, formatDiffPreview } from "./diff-preview.js";

export type ApprovalPanelProps = ApprovalNotice;
export interface PermissionPanelProps {
  state: PermissionState;
}

export function ApprovalPanel(notice: ApprovalPanelProps): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      {formatApprovalPanel(notice, { includeDiff: false })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
      {notice.diff && <DiffPreview diff={notice.diff} maxLines={40} />}
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
  options: { includeDiff?: boolean } = {},
): string {
  const target = approvalTarget(notice.toolName, notice.args);
  const lines = [
    `[审批] ${notice.toolName}`,
    `目标: ${target}`,
    `任务: ${notice.taskId}`,
    `allow once: approve ${notice.taskId}`,
    `allow session: approve-session ${notice.taskId}`,
    `deny: reject ${notice.taskId}`,
    `edit: modify ${notice.taskId} <content>`,
  ];
  if (options.includeDiff !== false && notice.diff) {
    const diff = formatDiffPreview(notice.diff, { maxLines: 40 });
    if (diff) lines.push("Diff:", diff);
  }
  return lines.join("\n");
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
