import React from "react";
import { Box, Text } from "ink";
import { terminalWidth, visualRows } from "./terminal-width.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
  renderWidth?: number;
  startOffsetRows?: number;
  visibleRows?: number;
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
  renderWidth = 80,
  startOffsetRows = 0,
  visibleRows,
}: LogoPanelProps): React.ReactNode {
  const rows = clipRows(
    buildLogoPanelRows({
      name,
      subtitle,
      model,
      cwd,
      sessionMode,
      permissionMode,
      mcpSummary,
      taskSummary,
      cwdMaxLength,
      renderWidth,
    }),
    startOffsetRows,
    visibleRows,
  );

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {rows.map((row, index) => (
        <Text key={`${index}:${row}`} dimColor={index > 0 || !row.startsWith(name)}>
          {index === 0 && row.startsWith(name) ? (
            <>
              <Text bold color="cyan">
                {name}
              </Text>
              <Text dimColor>{row.slice(name.length)}</Text>
            </>
          ) : (
            row
          )}
        </Text>
      ))}
    </Box>
  );
}

export function truncateLogoCwd(value: string, maxLength = 48): string {
  return truncateMiddleTerminalText(value, maxLength);
}

export function buildLogoPanelRows({
  name = "pico",
  subtitle = "Agent Harness",
  model,
  cwd,
  sessionMode,
  permissionMode,
  mcpSummary,
  taskSummary,
  cwdMaxLength = 48,
  renderWidth = 80,
}: LogoPanelProps): string[] {
  const detail = model ?? subtitle;
  const parts = [
    detail,
    ...(cwd ? [truncateLogoCwd(cwd, cwdMaxLength)] : []),
    ...(sessionMode ? [`mode ${sessionMode}`] : []),
    ...(permissionMode ? [`perm ${permissionMode}`] : []),
    ...(mcpSummary ? [mcpSummary] : []),
    ...(taskSummary ? [taskSummary] : []),
  ];
  return visualRows(`${name} · ${parts.join(" · ")}`, Math.max(1, renderWidth));
}

function clipRows(rows: string[], startOffsetRows: number, visibleRows: number | undefined): string[] {
  const rawStart = Math.max(0, Math.floor(startOffsetRows));
  const start = rawStart === 0 ? 0 : Math.max(0, rawStart - 1);
  const end = visibleRows === undefined ? undefined : start + Math.max(0, Math.floor(visibleRows));
  return rows.slice(start, end);
}

function truncateMiddleTerminalText(value: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (terminalWidth(value) <= width) return value;
  if (width <= 3) return takeTerminalPrefix(value, width);

  const available = width - 3;
  const tailWidth = Math.ceil(available * 0.55);
  const headWidth = available - tailWidth;
  return `${takeTerminalPrefix(value, headWidth)}...${takeTerminalSuffix(value, tailWidth)}`;
}

function takeTerminalPrefix(value: string, maxWidth: number): string {
  let output = "";
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    const next = terminalWidth(segment);
    if (width + next > maxWidth) break;
    output += segment;
    width += next;
  }
  return output;
}

function takeTerminalSuffix(value: string, maxWidth: number): string {
  let output = "";
  let width = 0;
  const segments = Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!;
    const next = terminalWidth(segment);
    if (width + next > maxWidth) break;
    output = `${segment}${output}`;
    width += next;
  }
  return output;
}
