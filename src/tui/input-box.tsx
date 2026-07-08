// 输入框组件:用 ink 的 useInput 收集按键,累积成文本,Enter 提交。
// ink 没有内置 TextInput(ink-text-input 是独立包),这里自实现极简版,
// 避免再装一个依赖(对齐项目极简哲学)。
//
// 对标 Claude Code PromptInput,但极简化:
//   - 多行:Alt+Enter / Shift+Enter 插入换行,Enter 提交
//   - 输入历史:↑/↓ 翻最近 20 条(对标 onHistoryUp/Down)
//
// 支持:字符输入、基础光标编辑、Backspace/Delete、Enter 提交、Ctrl+C 退出(由 App 层处理)。

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  createInputControllerState,
  reduceInputControllerEvent,
  type SuggestionSource,
} from "./input-controller.js";
import { SuggestionList } from "./suggestions.js";

export interface InputBoxProps {
  /** 禁用状态(模型运行中) */
  disabled?: boolean;
  /** Slash command 候选源,query 不含前导 / */
  slashCommandSuggestions?: SuggestionSource;
  /** File mention 候选源,query 不含前导 @ */
  fileMentionSuggestions?: SuggestionSource;
  /** Enter 提交回调 */
  onSubmit: (text: string) => void;
}

export function InputBox({
  disabled,
  slashCommandSuggestions,
  fileMentionSuggestions,
  onSubmit,
}: InputBoxProps): React.ReactNode {
  const [controller, setController] = useState(createInputControllerState);

  useInput((input, key) => {
    setController((current) =>
      reduceInputControllerEvent(current, input, key, {
        disabled,
        slashCommandSuggestions,
        fileMentionSuggestions,
        onSubmit,
      }).state,
    );
  });

  const { text, cursor, activeSuggestions } = controller;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green" bold>
          ❯{" "}
        </Text>
        {disabled ? (
          <Text dimColor>模型运行中,请等待…</Text>
        ) : text.includes("\n") ? (
          <Box flexDirection="column">{renderMultilineTextWithCursor(text, cursor)}</Box>
        ) : (
          renderLineWithCursor(text, cursor)
        )}
      </Box>
      {!disabled && <SuggestionList session={activeSuggestions} />}
      {!disabled && (
        <Text dimColor>
          {" "}Enter 发送 · Alt/Shift+Enter 换行 · ←/→ 编辑 · ↑/↓ 历史/候选 · Tab 补全 · Ctrl+C 退出
        </Text>
      )}
    </Box>
  );
}

function renderMultilineTextWithCursor(text: string, cursor: number): React.ReactNode {
  const lines = text.split("\n");
  let offset = 0;

  return lines.map((line, index) => {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const hasCursor = cursor >= lineStart && cursor <= lineEnd;
    offset = lineEnd + 1;

    return (
      <Text key={index}>
        {hasCursor ? renderLineContentWithCursor(line, cursor - lineStart) : line}
      </Text>
    );
  });
}

function renderLineWithCursor(line: string, cursor: number): React.ReactNode {
  return <Text>{renderLineContentWithCursor(line, cursor)}</Text>;
}

function renderLineContentWithCursor(line: string, cursor: number): React.ReactNode {
  const safeCursor = Math.max(0, Math.min(cursor, line.length));
  return (
    <>
      {line.slice(0, safeCursor)}
      <Text color="gray">▋</Text>
      {line.slice(safeCursor)}
    </>
  );
}
