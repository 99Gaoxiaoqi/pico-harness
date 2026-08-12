import React from "react";
import { Box, Text } from "ink";
import { terminalWidth, truncateTerminalText } from "./terminal-width.js";
import { truncateLogoCwd } from "./logo-panel.js";

export interface StatusBarProps {
  phase?: "idle" | "running" | "approval" | "queued" | string;
  sessionMode?: string;
  forkFrom?: string;
  collaborationMode?: string;
  permissionMode?: string;
  graphMode?: boolean;
  mcpSummary?: string;
  contextSummary?: string;
  taskSummary?: string;
  summaryMaxLength?: number;
  renderWidth?: number;
}

export type StatusItem = readonly [label: string, value: string];

/** 状态栏 phase 值的中文映射，让普通用户看懂"空闲/运行/审批"。 */
const PHASE_LABEL: Record<string, string> = {
  idle: "空闲",
  running: "运行",
  approval: "审批",
  queued: "排队",
};

export function buildStatusItems({
  phase = "idle",
  sessionMode = "new",
  forkFrom,
  collaborationMode = "agent",
  permissionMode = "yolo",
  graphMode = false,
  mcpSummary,
  contextSummary,
  taskSummary,
  summaryMaxLength = 32,
}: StatusBarProps): StatusItem[] {
  const items: StatusItem[] = [
    ["phase", phase],
    ["mode", sessionMode],
  ];
  if (forkFrom !== undefined) {
    items.push(["forkFrom", shortSessionId(forkFrom)]);
  }
  items.push(["collab", collaborationMode], ["perm", permissionMode]);
  if (graphMode) items.push(["graph", "on"]);
  if (mcpSummary) items.push(["mcp", mcpSummary]);
  if (contextSummary) {
    items.push(["context", truncateLogoCwd(contextSummary, summaryMaxLength)]);
  }
  if (taskSummary) items.push(["task", truncateLogoCwd(taskSummary, summaryMaxLength)]);
  return items;
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
  const text = buildStatusBarText(props);

  return (
    <Box paddingX={1}>
      <Text dimColor wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}

export function buildStatusBarText(props: StatusBarProps): string {
  const items = buildStatusItems(props);
  const itemByLabel = new Map(items);
  const phase = itemByLabel.get("phase") ?? props.phase ?? "idle";
  const sessionMode = itemByLabel.get("mode") ?? props.sessionMode ?? "new";
  const forkFrom = itemByLabel.get("forkFrom");
  const permissionMode = itemByLabel.get("perm");
  const collaborationMode = itemByLabel.get("collab");
  const mcpSummary = itemByLabel.get("mcp");
  const modeText = forkFrom === undefined ? sessionMode : `${sessionMode} from ${forkFrom}`;
  const candidates = [
    `状态 ${PHASE_LABEL[phase] ?? phase}`,
    `模式 ${modeText}`,
    ...(collaborationMode ? [`协作 ${collaborationMode}`] : []),
    ...(permissionMode ? [`权限 ${permissionMode}`] : []),
    ...(mcpSummary ? [mcpSummary] : []),
    ...(itemByLabel.has("context") ? [`上下文 ${itemByLabel.get("context")}`] : []),
    ...(itemByLabel.has("task") ? [`任务 ${itemByLabel.get("task")}`] : []),
  ];
  return fitStatusParts(candidates, props.renderWidth ?? 80);
}

function fitStatusParts(parts: string[], width: number): string {
  const maxWidth = Math.max(1, Math.floor(width));
  for (let count = parts.length; count > 0; count--) {
    const candidate = parts.slice(0, count).join(" · ");
    if (terminalWidth(candidate) <= maxWidth) return candidate;
  }
  return truncateTerminalText(parts[0] ?? "", maxWidth);
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 4)}...${sessionId.slice(-6)}`;
}
