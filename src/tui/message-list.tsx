// 消息列表渲染:把 TuiEntry[] 分发成对应 ink 组件。
// 对标 Claude Code 的消息流渲染(工具调用用树形缩进 ⎿,状态用颜色)。

import React from "react";
import { Box, Text } from "ink";
import type { TuiEntry } from "./tui-reporter.js";
import { ToolCard } from "./tool-card.js";

export function MessageList({ entries }: { entries: TuiEntry[] }): React.ReactNode {
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => {
        const prev = entries[i - 1];
        // 轮次分隔:遇到新的 user 消息,且前面已有内容时,加一条淡色分隔线
        const showSeparator = entry.kind === "user" && prev !== undefined;
        return (
          <React.Fragment key={i}>
            {showSeparator && <Separator />}
            <EntryView entry={entry} />
          </React.Fragment>
        );
      })}
    </Box>
  );
}

/** 轮次分隔:淡色虚线,让多轮对话结构清晰 */
function Separator(): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text dimColor>─</Text>
    </Box>
  );
}

function EntryView({ entry }: { entry: TuiEntry }): React.ReactNode {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="green" bold>
            ❯{" "}
          </Text>
          <Text>{entry.content}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1}>
          <AssistantText content={entry.content} />
        </Box>
      );

    case "tool":
      return <ToolCard name={entry.name} args={entry.args} status={entry.status} summary={entry.summary} />;

    case "thinking":
      // thinking 占位由 App 层的 Spinner 渲染,这里不重复显示
      return null;

    default:
      return null;
  }
}

/**
 * assistant 文本:wrap + 极简代码块检测。
 * 检测到 ``` 包裹的代码块时,用青色 + 左侧缩进渲染;其余普通文本。
 * 保持极简:不做完整 markdown,仅代码块着色。
 */
function AssistantText({ content }: { content: string }): React.ReactNode {
  const segments = splitCodeBlocks(content);
  return (
    <Box flexDirection="column">
      {segments.map((seg, i) =>
        seg.code ? (
          <Box key={i} marginLeft={2}>
            <Text color="cyan" wrap="wrap">
              {seg.text}
            </Text>
          </Box>
        ) : (
          <Text key={i} wrap="wrap">
            {seg.text}
          </Text>
        ),
      )}
    </Box>
  );
}

type Segment = { text: string; code: boolean };

/**
 * 把文本按 ``` 代码围栏拆段。
 * 极简实现:按 ``` 分割,奇数下标(第 2、4、… 段)为代码块内容。
 */
function splitCodeBlocks(text: string): Segment[] {
  if (!text.includes("```")) {
    return [{ text, code: false }];
  }
  const parts = text.split("```");
  return parts.map((part, i) => {
    // 跳过首行可能的语言标识(如 ```ts)后的空行,保留代码体
    const body = i % 2 === 1 ? stripFenceLang(part) : part;
    return { text: body, code: i % 2 === 1 };
  });
}

/** 去掉代码块开头的语言标识行(如 "ts\n…"),只保留代码体 */
function stripFenceLang(code: string): string {
  // 首行若只是单个单词语言标识(无空格、短),整行去掉
  const nl = code.indexOf("\n");
  if (nl === -1) return code;
  const firstLine = code.slice(0, nl).trim();
  if (/^[a-zA-Z0-9+#.-]{1,15}$/.test(firstLine)) {
    return code.slice(nl + 1);
  }
  return code;
}
