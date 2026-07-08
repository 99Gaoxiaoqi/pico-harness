import React from "react";
import { Box, Text } from "ink";
import type { ClaudeAgentSource, ClaudeAgentSummary } from "../input/agent-loader.js";

export const AGENT_NAME_WIDTH = 24;
export const AGENT_DESCRIPTION_WIDTH = 56;

export interface AgentListProps {
  agents: readonly ClaudeAgentSummary[];
}

export interface AgentRow {
  key: string;
  name: string;
  sourceTag: string;
  description: string;
  tools: string;
}

export function AgentList({ agents }: AgentListProps): React.ReactNode {
  const rows = formatAgentRows(agents);
  if (rows.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>No agents available.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {rows.map((row) => (
        <Box key={row.key} flexDirection="column">
          <Box>
            <Text bold>{row.name}</Text>
            <Text> </Text>
            <Text color="cyan">{row.sourceTag}</Text>
            <Text> </Text>
            <Text>{row.description}</Text>
          </Box>
          {row.tools ? (
            <Box marginLeft={2}>
              <Text dimColor>tools: {row.tools}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function formatAgentRows(
  agents: readonly ClaudeAgentSummary[],
): AgentRow[] {
  return agents.map((agent, index) => ({
    key: `${agent.source}:${agent.name}:${index}`,
    name: truncateInline(agent.name, AGENT_NAME_WIDTH),
    sourceTag: `[${formatAgentSource(agent.source)}]`,
    description: truncateInline(agent.description || "(no description)", AGENT_DESCRIPTION_WIDTH),
    tools: agent.tools?.join(", ") ?? "",
  }));
}

function formatAgentSource(source: ClaudeAgentSource | undefined): string {
  if (source === undefined) return "unknown";
  return source === "builtin" ? "built-in" : source;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}
