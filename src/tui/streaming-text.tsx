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

// 兼容保留旧的代码块拆分导出；实际渲染统一走 MarkdownText。
export type Segment = { text: string; code: boolean };

/** 把文本按 ``` 代码围栏拆段。 */
export function splitCodeBlocks(text: string): Segment[] {
  if (!text.includes("```")) {
    return [{ text, code: false }];
  }
  const parts = text.split("```");
  return parts.map((part, i) => {
    const body = i % 2 === 1 ? stripFenceLang(part) : part;
    return { text: body, code: i % 2 === 1 };
  });
}

/** 去掉代码块开头的语言标识行(如 "ts\n…"),只保留代码体 */
function stripFenceLang(code: string): string {
  const nl = code.indexOf("\n");
  if (nl === -1) return code;
  const firstLine = code.slice(0, nl).trim();
  if (/^[a-zA-Z0-9+#.-]{1,15}$/.test(firstLine)) {
    return code.slice(nl + 1);
  }
  return code;
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
