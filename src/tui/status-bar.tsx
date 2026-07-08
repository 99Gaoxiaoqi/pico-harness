import React from "react";
import { Box, Text } from "ink";

export interface StatusBarProps {
  model: string;
  provider: string;
  cwd: string;
  sessionMode: string;
}

export type StatusItem = readonly [label: string, value: string];

export function buildStatusItems({
  model,
  provider,
  cwd,
  sessionMode,
}: StatusBarProps): StatusItem[] {
  return [
    ["model", model],
    ["provider", provider],
    ["cwd", cwd],
    ["session", sessionMode],
  ];
}

export function StatusBar(props: StatusBarProps): React.ReactNode {
  const text = buildStatusItems(props)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" | ");

  return (
    <Box paddingX={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
