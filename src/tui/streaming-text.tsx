// 流式文本渲染:按行边界分割 stable/unstable(对标 Claude Code StreamingMarkdown)。
//
// 核心优化:模型流式输出时,每次 onTextDelta 增量追加。
// 朴素实现是整段文本每次 delta 都重渲染 + 重解析代码块(O(n²))。
// 本组件按最后一个换行符分割:
//   - stable = 最后一个 \n 及之前的内容(已完成的行,不再变化)
//   - unstable = 最后一个 \n 之后的内容(当前进行中的行,每次 delta 变化)
// stable 部分 React.memo 化；普通 delta 只重解析当前行，出现新换行时才推进稳定区。

import React, { memo } from "react";
import { Box } from "ink";
import { MarkdownText } from "./markdown-text.js";

export function StreamingText({ content }: { content: string }): React.ReactNode {
  const { stable, unstable } = splitAtLastNewline(content);
  return (
    <Box flexDirection="column">
      {stable && <StableLines key="stable" text={stable} />}
      {unstable && <UnstableLine key="unstable" text={unstable} />}
    </Box>
  );
}

/** 已固化的行:memo 化,text 不变时跳过重渲染 */
const StableLines = memo(function StableLines({ text }: { text: string }) {
  return <MarkdownText content={text} />;
});

/** 当前进行中的行:每次 delta 重渲染(只处理这一行,代价小) */
const UnstableLine = memo(function UnstableLine({ text }: { text: string }) {
  return <MarkdownText content={text} />;
});

/**
 * 按最后一个换行符分割。
 * stable 含末尾换行(完整的行),unstable 是未完成的行(无换行结尾)。
 * 若没有换行符,全部是 unstable(第一行还在写)。
 */
function splitAtLastNewline(text: string): { stable: string; unstable: string } {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl === -1) {
    return { stable: "", unstable: text };
  }
  // stable 含到换行符(含),unstable 是换行符之后
  return { stable: text.slice(0, lastNl + 1), unstable: text.slice(lastNl + 1) };
}

/**
 * 判断流式文本的 stable 边界是否推进了(用于外层 memo 比较)。
 * 导出供测试验证分割逻辑。
 */
export function getStableBoundary(text: string): number {
  const lastNl = text.lastIndexOf("\n");
  return lastNl === -1 ? 0 : lastNl + 1;
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
export function CompletedText({ content }: { content: string }): React.ReactNode {
  return <MarkdownText content={content} />;
}
