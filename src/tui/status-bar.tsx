import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  model: string;
  provider?: string;
  cwd: string;
  sessionMode?: string;
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
  permissionMode = "ask",
  thinkingEffort = "off",
  cwdMaxLength = 32,
}: StatusBarProps): StatusItem[] {
  return [
    ["model", model],
    ["provider", provider],
    ["cwd", truncateMiddle(cwd, cwdMaxLength)],
    ["mode", sessionMode],
    ["perm", permissionMode],
    ["think", thinkingEffort],
  ];
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
  const items = buildStatusItems(props);
  const [model, provider, cwd, sessionMode, permissionMode, thinkingEffort] = items.map(
    ([, value]) => value,
  );
  const providerText = provider === "auto" ? "provider auto" : provider;
  const text = [
    `${model}/${providerText}`,
    `mode ${sessionMode}`,
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
