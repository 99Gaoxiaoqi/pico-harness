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
    buildLogoPanelFrameRows({
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
    <Box flexDirection="column" paddingX={1}>
      {rows.map((row, index) =>
        row === "" ? (
          <Box key={`${index}:blank`} height={1} />
        ) : (
          <Text key={`${index}:${row}`} dimColor={!row.startsWith(name)}>
            {row.startsWith(name) ? (
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
        ),
      )}
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
  const compact = renderWidth <= 24;
  const detail = model ?? subtitle;
  const parts = [
    detail,
    ...(cwd ? [truncateLogoCwd(cwd, cwdMaxLength)] : []),
    ...(!compact && sessionMode ? [`mode ${sessionMode}`] : []),
    ...(!compact && permissionMode ? [`perm ${permissionMode}`] : []),
    ...(!compact && mcpSummary ? [mcpSummary] : []),
    ...(!compact && taskSummary ? [taskSummary] : []),
  ];
  return visualRows(`${name} · ${parts.join(" · ")}`, Math.max(1, renderWidth));
}

function buildLogoPanelFrameRows(props: LogoPanelProps): string[] {
  return ["", ...buildLogoPanelRows(props)];
}

function clipRows(
  rows: string[],
  startOffsetRows: number,
  visibleRows: number | undefined,
): string[] {
  const start = Math.max(0, Math.floor(startOffsetRows));
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
