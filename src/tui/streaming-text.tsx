// 流式文本渲染统一走 TerminalMarkdownModel。
//
// Markdown 代码围栏、列表和强调语法都可能跨越换行；按最后一个换行符
// 切分会把一个语义块拆成两个不同的文档，导致流式阶段和最终阶段排版不一致。
// 因此每次内容变化都以完整 token tree 渲染，保证 render/measure/clip 一致。

import React from "react";
import { MarkdownText } from "./markdown-text.js";

export function StreamingText({
  content,
  width,
  startRow,
  rows,
}: {
  content: string;
  width?: number;
  startRow?: number;
  rows?: number;
}): React.ReactNode {
  return <MarkdownText content={content} width={width} startRow={startRow} rows={rows} />;
}

/** 渲染已完成的 assistant Markdown 文本。 */
export function CompletedText({
  content,
  width,
  startRow,
  rows,
}: {
  content: string;
  width?: number;
  startRow?: number;
  rows?: number;
}): React.ReactNode {
  return <MarkdownText content={content} width={width} startRow={startRow} rows={rows} />;
}
