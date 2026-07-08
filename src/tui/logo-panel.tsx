import React from "react";
import { Box, Text } from "ink";

export interface LogoPanelProps {
  name?: string;
  subtitle?: string;
}

export function LogoPanel({
  name = "pico",
  subtitle = "Agent Harness",
}: LogoPanelProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text>
        <Text bold color="cyan">
          {name}
        </Text>
        <Text dimColor> {subtitle}</Text>
      </Text>
    </Box>
  );
}
