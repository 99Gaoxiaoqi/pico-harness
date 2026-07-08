import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  model: string;
  provider?: string;
  cwd: string;
  sessionMode?: string;
  forkFrom?: string;
  permissionMode?: string;
  thinkingEffort?: string;
  cwdMaxLength?: number;
}

export type StatusItem = readonly [label: string, value: string];

export function buildStatusItems({
  model,
  provider = "auto",
  cwd,
  sessionMode = "new",
  forkFrom,
  permissionMode = "ask",
  thinkingEffort = "off",
  cwdMaxLength = 32,
}: StatusBarProps): StatusItem[] {
  const items: StatusItem[] = [
    ["model", model],
    ["provider", provider],
    ["cwd", truncateMiddle(cwd, cwdMaxLength)],
    ["mode", sessionMode],
  ];
  if (forkFrom !== undefined) {
    items.push(["forkFrom", shortSessionId(forkFrom)]);
  }
  items.push(["perm", permissionMode], ["think", thinkingEffort]);
  return items;
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
  const items = buildStatusItems(props);
  const itemByLabel = new Map(items);
  const model = itemByLabel.get("model") ?? props.model;
  const provider = itemByLabel.get("provider") ?? props.provider ?? "auto";
  const cwd = itemByLabel.get("cwd") ?? props.cwd;
  const sessionMode = itemByLabel.get("mode") ?? props.sessionMode ?? "new";
  const forkFrom = itemByLabel.get("forkFrom");
  const permissionMode = itemByLabel.get("perm") ?? props.permissionMode ?? "ask";
  const thinkingEffort = itemByLabel.get("think") ?? props.thinkingEffort ?? "off";
  const providerText = provider === "auto" ? "provider auto" : provider;
  const modeText = forkFrom === undefined ? sessionMode : `${sessionMode} from ${forkFrom}`;
  const text = [
    `${model}/${providerText}`,
    `mode ${modeText}`,
    `perm ${permissionMode}`,
    `think ${thinkingEffort}`,
    cwd,
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
