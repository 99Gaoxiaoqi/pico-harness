// 消息列表渲染:把 TuiEntry[] 分发成对应 ink 组件。
// 对标 Claude Code 的消息流渲染(工具调用用树形缩进 ⎿,状态用颜色)。

import React from "react";
import { Box, Text } from "ink";
import type { TuiEntry } from "./tui-reporter.js";

export function MessageList({ entries }: { entries: TuiEntry[] }): React.ReactNode {
  return (
    <Box flexDirection="column">
      {entries.map((entry, i) => (
        <EntryView key={i} entry={entry} />
      ))}
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
          <Text wrap="wrap">{entry.content}</Text>
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

/** 工具调用卡片:⎿ tool_name(args) → ✓/✗ 摘要 */
function ToolCard({
  name,
  args,
  status,
  summary,
}: {
  name: string;
  args: string;
  status: "running" | "done" | "error";
  summary?: string;
}): React.ReactNode {
  // 参数摘要:JSON 太长时只显示前 80 字符
  const argsPreview = args.length > 80 ? `${args.slice(0, 80)}…` : args;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text dimColor>⎿ </Text>
        <Text color="cyan">{name}</Text>
        <Text dimColor>(</Text>
        <Text dimColor>{argsPreview}</Text>
        <Text dimColor>) </Text>
        {status === "running" && <Text color="yellow">⠋</Text>}
        {status === "done" && <Text color="green">✓</Text>}
        {status === "error" && <Text color="red">✗</Text>}
      </Box>
      {summary && (
        <Box marginLeft={2}>
          <Text dimColor>{summary}</Text>
        </Box>
      )}
    </Box>
  );
}
