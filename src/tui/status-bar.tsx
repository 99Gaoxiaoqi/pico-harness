import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  phase?: "idle" | "running" | "approval" | "queued" | string;
  sessionMode?: string;
  forkFrom?: string;
  permissionMode?: string;
  contextSummary?: string;
  taskSummary?: string;
  summaryMaxLength?: number;
}

export type StatusItem = readonly [label: string, value: string];

export function buildStatusItems({
  phase = "idle",
  sessionMode = "new",
  forkFrom,
  permissionMode = "ask",
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
  items.push(["perm", permissionMode]);
  if (contextSummary) items.push(["context", truncateMiddle(contextSummary, summaryMaxLength)]);
  if (taskSummary) items.push(["task", truncateMiddle(taskSummary, summaryMaxLength)]);
  return items;
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
  const items = buildStatusItems(props);
  const itemByLabel = new Map(items);
  const phase = itemByLabel.get("phase") ?? props.phase ?? "idle";
  const sessionMode = itemByLabel.get("mode") ?? props.sessionMode ?? "new";
  const forkFrom = itemByLabel.get("forkFrom");
  const permissionMode = itemByLabel.get("perm") ?? props.permissionMode ?? "ask";
  const modeText = forkFrom === undefined ? sessionMode : `${sessionMode} from ${forkFrom}`;
  const text = [
    `phase ${phase}`,
    `mode ${modeText}`,
    `perm ${permissionMode}`,
    ...(itemByLabel.has("context") ? [`ctx ${itemByLabel.get("context")}`] : []),
    ...(itemByLabel.has("task") ? [`task ${itemByLabel.get("task")}`] : []),
  ].join(" · ");

  return (
    <Box paddingX={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);

  const available = maxLength - 3;
  const tailLength = Math.ceil(available * 0.55);
  const headLength = available - tailLength;

  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 4)}...${sessionId.slice(-6)}`;
}
