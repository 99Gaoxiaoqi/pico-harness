import React from "react";
import { Box, Text } from "ink";

export interface LogoPanelProps {
  name?: string;
  subtitle?: string;
  model?: string;
  cwd?: string;
  sessionMode?: string;
  permissionMode?: string;
  mcpSummary?: string;
  taskSummary?: string;
  cwdMaxLength?: number;
}

export function LogoPanel({
  name = "pico",
  subtitle = "Agent Harness",
  model,
  cwd,
  sessionMode,
  permissionMode,
  mcpSummary,
  taskSummary,
  cwdMaxLength = 48,
}: LogoPanelProps): React.ReactNode {
  const detail = model ?? subtitle;
  const parts = [
    detail,
    ...(cwd ? [truncateLogoCwd(cwd, cwdMaxLength)] : []),
    ...(sessionMode ? [`mode ${sessionMode}`] : []),
    ...(permissionMode ? [`perm ${permissionMode}`] : []),
    ...(mcpSummary ? [mcpSummary] : []),
    ...(taskSummary ? [taskSummary] : []),
  ];

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text wrap="wrap">
        <Text bold color="cyan">
          {name}
        </Text>
        <Text dimColor> · {parts.join(" · ")}</Text>
      </Text>
    </Box>
  );
}

export function truncateLogoCwd(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);

  const available = maxLength - 3;
  const tailLength = Math.ceil(available * 0.55);
  const headLength = available - tailLength;

  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}
