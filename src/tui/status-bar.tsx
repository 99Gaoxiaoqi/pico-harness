import React from "react";
import { Box, Text } from "ink";
import { terminalWidth, truncateTerminalText } from "./terminal-width.js";
import { truncateLogoCwd } from "./logo-panel.js";

export interface StatusBarProps {
  /** @deprecated model is shown by LogoPanel. Kept optional for source compatibility. */
  model?: string;
  /** @deprecated provider should be passed as contextSummary. */
  provider?: string;
  /** @deprecated cwd is shown by LogoPanel. */
  cwd?: string;
  phase?: "idle" | "running" | "approval" | "queued" | string;
  sessionMode?: string;
  forkFrom?: string;
  permissionMode?: string;
  contextSummary?: string;
  taskSummary?: string;
  summaryMaxLength?: number;
  cwdMaxLength?: number;
  renderWidth?: number;
}

export type StatusItem = readonly [label: string, value: string];

export function buildStatusItems({
  phase = "idle",
  sessionMode = "new",
  forkFrom,
  permissionMode = "yolo",
  contextSummary,
  taskSummary,
  summaryMaxLength = 32,
  provider,
}: StatusBarProps): StatusItem[] {
  const context = contextSummary ?? provider;
  const items: StatusItem[] = [
    ["phase", phase],
    ["mode", sessionMode],
  ];
  if (forkFrom !== undefined) {
    items.push(["forkFrom", shortSessionId(forkFrom)]);
  }
  if (permissionMode !== sessionMode) items.push(["perm", permissionMode]);
  if (context) items.push(["context", truncateLogoCwd(context, summaryMaxLength)]);
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
  const modeText = forkFrom === undefined ? sessionMode : `${sessionMode} from ${forkFrom}`;
  const candidates = [
    `phase ${phase}`,
    `mode ${modeText}`,
    ...(permissionMode ? [`perm ${permissionMode}`] : []),
    ...(itemByLabel.has("context") ? [`ctx ${itemByLabel.get("context")}`] : []),
    ...(itemByLabel.has("task") ? [`task ${itemByLabel.get("task")}`] : []),
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
