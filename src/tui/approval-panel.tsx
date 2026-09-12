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
import type { PlanControlNotice } from "./plan-control-notice.js";
import { wrappedVisualRows } from "./terminal-width.js";

const DEFAULT_DIFF_PREVIEW_LINES = 22;
const LAYOUT_SHELL_HORIZONTAL_PADDING = 2;
const APPROVAL_PANEL_HORIZONTAL_PADDING = 2;
const APPROVAL_DIALOG_PREFIX = "approval:pending:";
const PLAN_CONTROL_DIALOG_PREFIX = "plan-control:pending:";

export function approvalDialogId(taskId: string): string {
  return `${APPROVAL_DIALOG_PREFIX}${taskId}`;
}

export function isApprovalDialogId(id: string): boolean {
  return id.startsWith(APPROVAL_DIALOG_PREFIX);
}

export function planControlDialogId(controlId: string): string {
  return `${PLAN_CONTROL_DIALOG_PREFIX}${controlId}`;
}

export function isPlanControlDialogId(id: string): boolean {
  return id.startsWith(PLAN_CONTROL_DIALOG_PREFIX);
}

export interface ApprovalPanelProps extends ApprovalNotice {
  diffExpanded?: boolean;
  selectedIndex?: number;
  feedback?: string;
}
export type PlanControlPanelProps = PlanControlNotice & {
  diffExpanded?: boolean;
  selectedIndex?: number;
  feedback?: string;
};
export interface PermissionPanelProps {
  state: PermissionState;
}
export type ApprovalPanelAction = "approve" | "approve-session" | "reject";
export type PlanControlPanelAction =
  | "execute"
  | "continue-editing"
  | "reject-exit"
  | "resume-execution"
  | "cancel-execution"
  | "replan-execution";
export type DecisionPanelAction = ApprovalPanelAction | PlanControlPanelAction;
export type ApprovalPanelKeyAction = DecisionPanelAction | "toggle-diff" | "move-up" | "move-down";
export interface ApprovalPanelState {
  diffExpanded: boolean;
  selectedIndex: number;
}
export interface InteractiveApprovalPanelProps extends ApprovalPanelProps {
  onAction: (
    action: ApprovalPanelAction,
    feedback?: string,
  ) => boolean | void | Promise<boolean | void>;
  onDiffExpandedChange?: (expanded: boolean) => void;
  keybindings?: UserKeybindingConfig;
}
export type InteractivePlanControlPanelProps = PlanControlPanelProps & {
  onAction: (
    action: PlanControlPanelAction,
    feedback?: string,
  ) => boolean | void | Promise<boolean | void>;
  onDiffExpandedChange?: (expanded: boolean) => void;
  keybindings?: UserKeybindingConfig;
};

type DecisionNotice = ApprovalNotice | PlanControlNotice;

interface InteractiveDecisionPanelProps {
  readonly notice: DecisionNotice;
  readonly onAction: (
    action: DecisionPanelAction,
    feedback?: string,
  ) => boolean | void | Promise<boolean | void>;
  readonly onDiffExpandedChange?: (expanded: boolean) => void;
  readonly diffExpanded?: boolean;
  readonly keybindings?: UserKeybindingConfig;
}

export function InteractiveApprovalPanel({
  onAction,
  onDiffExpandedChange,
  diffExpanded,
  keybindings,
  ...notice
}: InteractiveApprovalPanelProps): React.ReactNode {
  return (
    <InteractiveDecisionPanel
      notice={notice}
      onAction={onAction as InteractiveDecisionPanelProps["onAction"]}
      onDiffExpandedChange={onDiffExpandedChange}
      diffExpanded={diffExpanded}
      keybindings={keybindings}
    />
  );
}

export function InteractivePlanControlPanel({
  onAction,
  onDiffExpandedChange,
  diffExpanded,
  keybindings,
  ...notice
}: InteractivePlanControlPanelProps): React.ReactNode {
  return (
    <InteractiveDecisionPanel
      notice={notice}
      onAction={onAction as InteractiveDecisionPanelProps["onAction"]}
      onDiffExpandedChange={onDiffExpandedChange}
      diffExpanded={diffExpanded}
      keybindings={keybindings}
    />
  );
}

function InteractiveDecisionPanel({
  notice,
  onAction,
  onDiffExpandedChange,
  diffExpanded,
  keybindings,
}: InteractiveDecisionPanelProps): React.ReactNode {
  const [state, setState] = useState<ApprovalPanelState>(() => ({
    diffExpanded: diffExpanded ?? Boolean(decisionDetails(notice)),
    selectedIndex: 0,
  }));
  const [feedback, setFeedback] = useState("");
  const submittedTaskId = useRef<string | null>(null);
  const expanded = diffExpanded ?? state.diffExpanded;
  const planControl = notice.kind === "plan-control";
  const interruptedPlan = planControl && notice.mode === "interrupted";
  const hasSessionOption = notice.kind === "tool" && notice.sessionScope !== undefined;
  const optionCount = planControl ? 3 : hasSessionOption ? 3 : 2;

  useInput((input, key) => {
    const action = resolveApprovalPanelKey(
      input,
      key,
      keybindings,
      state.selectedIndex,
      hasSessionOption,
      planControl,
      interruptedPlan,
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
    if (action === "continue-editing" && feedback.trim().length === 0) return;
    const decisionId = notice.kind === "tool" ? notice.taskId : notice.controlId;
    if (submittedTaskId.current === decisionId) return;
    submittedTaskId.current = decisionId;
    const outcome = onAction(action, action === "continue-editing" ? feedback.trim() : undefined);
    if (outcome instanceof Promise) {
      void outcome.then(
        (accepted) => {
          if (accepted === false) submittedTaskId.current = null;
        },
        () => {
          submittedTaskId.current = null;
        },
      );
    } else if (outcome === false) {
      submittedTaskId.current = null;
    }
  });

  useInput((input, key) => {
    if (!planControl || interruptedPlan || state.selectedIndex !== 1 || key.return || key.escape)
      return;
    const extendedKey = key as typeof key & { backspace?: boolean; delete?: boolean };
    if (extendedKey.backspace || extendedKey.delete) {
      setFeedback((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0 && !/[jkney]/iu.test(input)) {
      setFeedback((current) => `${current}${input}`);
    }
  });

  return (
    <DecisionPanel
      notice={notice}
      diffExpanded={expanded}
      selectedIndex={state.selectedIndex}
      feedback={feedback}
    />
  );
}

export function ApprovalPanel({
  diffExpanded = false,
  selectedIndex = 0,
  feedback,
  ...notice
}: ApprovalPanelProps): React.ReactNode {
  return (
    <DecisionPanel
      notice={notice}
      diffExpanded={diffExpanded}
      selectedIndex={selectedIndex}
      feedback={feedback}
    />
  );
}

export function PlanControlPanel({
  diffExpanded = false,
  selectedIndex = 0,
  feedback,
  ...notice
}: PlanControlPanelProps): React.ReactNode {
  return (
    <DecisionPanel
      notice={notice}
      diffExpanded={diffExpanded}
      selectedIndex={selectedIndex}
      feedback={feedback}
    />
  );
}

function DecisionPanel({
  notice,
  diffExpanded,
  selectedIndex,
  feedback,
}: {
  readonly notice: DecisionNotice;
  readonly diffExpanded: boolean;
  readonly selectedIndex: number;
  readonly feedback?: string;
}): React.ReactNode {
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
      {formatDecisionPanel(notice, { diffExpanded, selectedIndex, feedback })
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
    feedback?: string;
  } = {},
): string {
  return formatDecisionPanel(notice, options);
}

export function formatPlanControlPanel(
  notice: PlanControlNotice,
  options: {
    diffExpanded?: boolean;
    includeDiff?: boolean;
    maxDiffPreviewLines?: number;
    selectedIndex?: number;
    feedback?: string;
  } = {},
): string {
  return formatDecisionPanel(notice, options);
}

function formatDecisionPanel(
  notice: DecisionNotice,
  options: {
    diffExpanded?: boolean;
    includeDiff?: boolean;
    maxDiffPreviewLines?: number;
    selectedIndex?: number;
    feedback?: string;
  },
): string {
  const planControl = notice.kind === "plan-control";
  const interruptedPlan = planControl && notice.mode === "interrupted";
  const target = planControl
    ? notice.mode === "review"
      ? notice.proposal.title
      : notice.message
    : (notice.preview?.target ?? approvalTarget(notice.toolName, notice.args));
  const summary = planControl
    ? notice.message
    : (notice.preview?.summary ?? approvalSummary(notice.message));
  const diff = decisionDetails(notice);
  const diffExpanded = options.diffExpanded ?? options.includeDiff ?? Boolean(diff);
  const hasSessionOption = notice.kind === "tool" && notice.sessionScope !== undefined;
  const approvalOptions: Array<{ label: string; action: DecisionPanelAction }> = interruptedPlan
    ? [
        { label: "继续执行", action: "resume-execution" },
        { label: "取消执行", action: "cancel-execution" },
        { label: "重新规划", action: "replan-execution" },
      ]
    : planControl
      ? [
          { label: "执行计划", action: "execute" },
          { label: "继续修改（需输入反馈）", action: "continue-editing" },
          { label: "拒绝并退出", action: "reject-exit" },
        ]
      : [
          { label: "允许", action: "approve" },
          ...(hasSessionOption
            ? [
                {
                  label: formatPermissionSessionScope(notice.sessionScope!),
                  action: "approve-session" as const,
                },
              ]
            : []),
          { label: "拒绝", action: "reject" },
        ];
  const selectedIndex = clampSelection(options.selectedIndex ?? 0, approvalOptions.length);
  const lines = [
    planControl
      ? interruptedPlan
        ? "计划执行已中断，请选择下一步："
        : "是否执行此计划？"
      : approvalQuestion(notice.toolName, target),
    `  ${target}`,
  ];
  if (diffExpanded && diff) {
    lines.push(
      planControl
        ? formatPlanDetailsPreview(diff, options.maxDiffPreviewLines)
        : formatDiffPreview(diff, options.maxDiffPreviewLines),
    );
  } else if (diff) {
    lines.push(planControl ? "计划详情已折叠" : formatDiffSummary(diff, false));
  }
  if (!diff && summary !== target) lines.push(`  ${summary}`);
  lines.push(
    ...approvalOptions.map(
      (option, index) => `${index === selectedIndex ? "❯" : " "} ${index + 1}. ${option.label}`,
    ),
    "  ↑/↓ or J/K to move · Enter to select · Esc to cancel · E to toggle diff",
  );
  if (planControl && !interruptedPlan && selectedIndex === 1) {
    lines.push(
      `  反馈: ${options.feedback?.trim() || "（直接打字输入修改意见，输入后按 Enter 提交）"}`,
    );
  }
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

export function measurePlanControlPanelRows(
  notice: PlanControlNotice,
  options: { diffExpanded: boolean; wrapWidth: number },
): number {
  const contentRows = formatPlanControlPanel(notice, { diffExpanded: options.diffExpanded })
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
  planControl = false,
  interruptedPlan = false,
): ApprovalPanelKeyAction | null {
  const arrowKey = key as typeof key & { upArrow?: boolean; downArrow?: boolean };
  if (arrowKey.upArrow || (input.toLowerCase() === "k" && !key.ctrl && !key.meta)) return "move-up";
  if (arrowKey.downArrow || (input.toLowerCase() === "j" && !key.ctrl && !key.meta))
    return "move-down";
  const normalized = input.toLowerCase();
  if (key.return && !key.ctrl && !key.meta) {
    return planControl
      ? interruptedPlan
        ? ((["resume-execution", "cancel-execution", "replan-execution"] as const)[selectedIndex] ??
          "resume-execution")
        : ((["execute", "continue-editing", "reject-exit"] as const)[selectedIndex] ?? "execute")
      : actionAtSelection(selectedIndex, hasSessionOption);
  }
  if (key.escape)
    return interruptedPlan ? "cancel-execution" : planControl ? "reject-exit" : "reject";
  if (normalized === "e" && !key.ctrl && !key.meta) return "toggle-diff";
  if (planControl) return null;
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

function decisionDetails(notice: DecisionNotice): string | undefined {
  if (notice.kind === "tool") return notice.preview?.diff ?? notice.diff;

  const source = notice.mode === "review" ? notice.proposal : notice.execution;
  const lines = [
    `版本: ${source.revision}`,
    ...(notice.mode === "review" && notice.proposal.overview ? [notice.proposal.overview] : []),
    ...source.steps.map(
      (step, index) =>
        `${index + 1}. [${step.status}] ${step.title}${step.description ? ` — ${step.description}` : ""}${step.note ? ` (${step.note})` : ""}`,
    ),
    ...(notice.mode === "review" && notice.proposal.risks?.length
      ? ["风险:", ...notice.proposal.risks.map((risk) => `- ${risk}`)]
      : []),
  ];
  return lines.join("\n");
}

function formatPlanDetailsPreview(details: string, maxLines = DEFAULT_DIFF_PREVIEW_LINES): string {
  const lines = details.split("\n");
  const visible = lines.slice(0, Math.max(0, maxLines));
  const hidden = Math.max(0, lines.length - visible.length);
  const suffix = hidden > 0 ? [`... 已隐藏 ${hidden} 行`] : [];
  return ["计划详情:", ...visible, ...suffix].join("\n");
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
  if (toolName === "edit_file") return `是否允许对 ${name} 执行此修改？`;
  if (toolName === "write_file") return `是否允许写入 ${name}？`;
  if (toolName === "read_file") return `是否允许读取 ${name}？`;
  if (toolName === "bash") return "是否允许执行此命令？";
  return `是否允许执行 ${toolName}？`;
}
