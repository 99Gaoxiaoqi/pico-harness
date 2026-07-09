// 输入框组件:用 ink 的 useInput 收集按键,累积成文本,Enter 提交。
// ink 没有内置 TextInput(ink-text-input 是独立包),这里自实现极简版,
// 避免再装一个依赖(对齐项目极简哲学)。
//
// 对标 Claude Code PromptInput,但极简化:
//   - 多行:Alt+Enter / Shift+Enter 插入换行,Enter 提交
//   - 输入历史:↑/↓ 翻最近 20 条(对标 onHistoryUp/Down)
//
// 支持:字符输入、基础光标编辑、Backspace/Delete、Enter 提交、Ctrl+C 退出(由 App 层处理)。

import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  createInputControllerState,
  reduceInputControllerEvent,
  type SlashArgumentSuggestionSource,
  type SuggestionSource,
} from "./input-controller.js";
import { SuggestionList } from "./suggestions.js";

export interface InputBoxProps {
  /** 禁用状态(模型运行中) */
  disabled?: boolean;
  /** 禁用时展示的静态提示 */
  disabledLabel?: string;
  /** Slash command 候选源,query 不含前导 / */
  slashCommandSuggestions?: SuggestionSource;
  /** Slash command 参数候选源,query 为当前参数前缀 */
  slashArgumentSuggestions?: SlashArgumentSuggestionSource;
  /** File mention 候选源,query 不含前导 @ */
  fileMentionSuggestions?: SuggestionSource;
  /** Enter 提交回调 */
  onSubmit: (text: string) => void;
}

export function InputBox({
  disabled,
  disabledLabel = "Running…",
  slashCommandSuggestions,
  slashArgumentSuggestions,
  fileMentionSuggestions,
  onSubmit,
}: InputBoxProps): React.ReactNode {
  const initialController = useRef(createInputControllerState());
  const controllerRef = useRef(initialController.current);
  const [controller, setController] = useState(initialController.current);

  useInput((input, key) => {
    const result = reduceInputControllerEvent(controllerRef.current, input, key, {
      disabled,
      slashCommandSuggestions,
      slashArgumentSuggestions,
      fileMentionSuggestions,
    });
    controllerRef.current = result.state;
    setController(result.state);
    if (result.submittedText !== undefined) {
      onSubmit(result.submittedText);
    }
  });

  const { text, cursor, activeSuggestions } = controller;

  return (
    <Box flexDirection="column">
      {renderInputPrompt({ disabled: Boolean(disabled), disabledLabel, text, cursor })}
      {!disabled && <SuggestionList session={activeSuggestions} />}
    </Box>
  );
}

export function renderInputPrompt({
  disabled,
  disabledLabel = "Running…",
  text,
  cursor,
}: {
  disabled: boolean;
  disabledLabel?: string;
  text: string;
  cursor: number;
}): React.ReactNode {
  return (
    <Box>
      <Text color={disabled ? "gray" : "green"} bold={!disabled}>
        ❯{" "}
      </Text>
      {renderInputContent(text, cursor, disabled, disabledLabel)}
    </Box>
  );
}

function renderInputContent(
  text: string,
  cursor: number,
  disabled: boolean,
  disabledLabel: string,
): React.ReactNode {
  if (disabled) {
    return (
      <Box flexDirection="column">
        {text ? renderMultilineText(text) : null}
        <Text dimColor>{disabledLabel}</Text>
      </Box>
    );
  }

  if (!text) {
    return <Text dimColor>Try &quot;fix this&quot; or / for commands</Text>;
  }

  if (text.includes("\n")) {
    return <Box flexDirection="column">{renderMultilineTextWithCursor(text, cursor)}</Box>;
  }

  return renderLineWithCursor(text, cursor);
}

function renderMultilineText(text: string): React.ReactNode {
  return text.split("\n").map((line, index) => (
    <Text key={index} dimColor>
      {line}
    </Text>
  ));
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
