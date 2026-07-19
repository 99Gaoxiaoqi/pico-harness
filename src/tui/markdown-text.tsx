import React, { useMemo } from "react";
import { TerminalMarkdownModel } from "./terminal-markdown-model.js";

/**
 * Render Markdown for the terminal.  Parsing and rendering are delegated to
 * TerminalMarkdownModel so layout measurement and viewport clipping use the
 * exact same token projection.
 */
export function MarkdownText({
  content,
  dimColor = false,
  width,
  startRow,
  rows,
}: {
  content: string;
  dimColor?: boolean;
  width?: number;
  startRow?: number;
  rows?: number;
}): React.ReactNode {
  const model = useMemo(() => new TerminalMarkdownModel(content), [content]);
  return model.render(width, dimColor, startRow, rows);
}

export { TerminalMarkdownModel } from "./terminal-markdown-model.js";
