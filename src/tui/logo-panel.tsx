import React from "react";
import { Box, Text } from "ink";

export interface LogoPanelProps {
  name?: string;
  subtitle?: string;
  model?: string;
  cwd?: string;
  cwdMaxLength?: number;
}

export function LogoPanel({
  name = "pico",
  subtitle = "Agent Harness",
  model,
  cwd,
  cwdMaxLength = 48,
}: LogoPanelProps): React.ReactNode {
  const detail = model ?? subtitle;
  const parts = cwd ? [detail, truncateMiddle(cwd, cwdMaxLength)] : [detail];

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text wrap="truncate">
        <Text bold color="cyan">
          {name}
        </Text>
        <Text dimColor> · {parts.join(" · ")}</Text>
      </Text>
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
