// 工具调用卡片:对标 Claude Code 的 AgentProgressLine(树形缩进 + 状态图标 + 参数着色)。
// 从 message-list.tsx 抽出独立组件,便于精修与测试。
//
// 渲染要点:
//   ⎿ <tool_name>(<着色参数>) <状态图标>
//     <summary>            (done=灰/error=红)
//
// 参数高亮:尝试 JSON.parse,成功则提取 path/command/url/query 等关键字段着色显示;
// 失败降级为原始字符串(截断)。

import React from "react";
import { Box, Text } from "ink";

/** 参数里需要高亮(青色)的关键字段,按优先级排序 */
const HIGHLIGHT_KEYS = ["path", "command", "url", "query", "file", "pattern"] as const;

export function ToolCard(props: {
  name: string;
  args: string;
  status: "running" | "done" | "error";
  summary?: string;
}): React.ReactNode {
  const { name, args, status, summary } = props;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text dimColor>⎿ </Text>
        <Text color="cyan">{name}</Text>
        <Text dimColor>(</Text>
        <ArgsView args={args} />
        <Text dimColor>) </Text>
        {status === "running" && <Text color="yellow">⠋</Text>}
        {status === "done" && <Text color="green">✓</Text>}
        {status === "error" && <Text color="red">✗</Text>}
      </Box>
      {summary && (
        <Box marginLeft={2}>
          <Text color={status === "error" ? "red" : undefined} dimColor={status !== "error"}>
            {summary}
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * 参数渲染:解析 JSON 后对关键字段着色。
 * 解析失败或为空时降级显示原始字符串(截断到 80 字符)。
 */
function ArgsView({ args }: { args: string }): React.ReactNode {
  const trimmed = args.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 降级:原始字符串(截断)
    const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    return <Text dimColor>{preview}</Text>;
  }

  // 仅对对象做字段着色,其他类型(数组/原始值)直接字符串化
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const text = JSON.stringify(parsed) ?? trimmed;
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return <Text dimColor>{preview}</Text>;
  }

  return <ParsedArgsView obj={parsed as Record<string, unknown>} />;
}

/** 把解析后的对象渲染成 `key:"value"` 序列,关键字段青色高亮 */
function ParsedArgsView({ obj }: { obj: Record<string, unknown> }): React.ReactNode {
  const entries = Object.entries(obj);
  return (
    <>
      {entries.map(([key, value], i) => (
        <React.Fragment key={key}>
          {i > 0 && <Text dimColor> </Text>}
          <ArgsField fieldKey={key} value={value} />
        </React.Fragment>
      ))}
    </>
  );
}

/** 单个字段:key 灰色,value 在关键字段时青色加粗 */
function ArgsField({ fieldKey, value }: { fieldKey: string; value: unknown }): React.ReactNode {
  const isHighlight = (HIGHLIGHT_KEYS as readonly string[]).includes(fieldKey);
  // value 简单字符串化(字符串去引号,其他 JSON 化,过长截断)
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw && raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;

  return (
    <>
      <Text dimColor>{fieldKey}:</Text>
      {isHighlight ? <Text color="cyan">{text}</Text> : <Text dimColor>{text}</Text>}
    </>
  );
}
