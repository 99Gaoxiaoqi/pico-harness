import React from "react";
import { Box, Text } from "ink";

export type DiffPreviewLineKind = "add" | "remove" | "meta" | "context";

export interface DiffPreviewLine {
  text: string;
  kind: DiffPreviewLineKind;
}

export interface DiffPreviewProps {
  diff?: string;
  maxLines?: number;
}

export function DiffPreview({ diff, maxLines }: DiffPreviewProps): React.ReactNode {
  const lines = splitDiffPreviewLines(diff, { maxLines });
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, index) => (
        <Text
          key={`${index}:${line.text}`}
          color={lineColor(line.kind)}
          dimColor={line.kind === "context"}
          wrap="truncate"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}

export function formatDiffPreview(
  diff: string | undefined,
  options: { maxLines?: number } = {},
): string {
  return splitDiffPreviewLines(diff, options)
    .map((line) => line.text)
    .join("\n");
}

export function formatOutputPreview(
  output: string | undefined,
  options: { maxLines?: number; expanded?: boolean } = {},
): string {
  if (!output) return "";

  const lines = output.split("\n");
  const maxLines = options.maxLines ?? (options.expanded ? 40 : 3);
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  if (hidden > 0) visible.push(`... 已截断 ${hidden} 行`);
  return visible.join("\n");
}

export function splitDiffPreviewLines(
  diff: string | undefined,
  options: { maxLines?: number } = {},
): DiffPreviewLine[] {
  if (!diff) return [];

  const allLines = diff.split("\n");
  const maxLines = options.maxLines ?? 80;
  const visible = allLines.slice(0, maxLines).map((text) => ({
    text,
    kind: classifyDiffLine(text),
  }));
  const hidden = allLines.length - visible.length;
  if (hidden > 0) {
    visible.push({ text: `... 已截断 ${hidden} 行`, kind: "meta" });
  }
  return visible;
}

function classifyDiffLine(line: string): DiffPreviewLineKind {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "remove";
  if (line.startsWith("@@") || line.startsWith("修改") || line.startsWith("新建")) return "meta";
  return "context";
}

function lineColor(kind: DiffPreviewLineKind): "green" | "red" | "yellow" | undefined {
  if (kind === "add") return "green";
  if (kind === "remove") return "red";
  if (kind === "meta") return "yellow";
  return undefined;
}
