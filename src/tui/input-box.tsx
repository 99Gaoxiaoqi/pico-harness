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
  getSuggestionContext,
  reduceInputControllerEvent,
  type InputControllerOptions,
  type InputControllerState,
  type InputKey,
  type SlashArgumentSuggestionSource,
  type SuggestionSource,
  type SuggestionSourceResult,
} from "./input-controller.js";
import type { ActiveSuggestionSession, InputSuggestion } from "./suggestions.js";
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
  /** 顶层焦点仲裁:只有当前按键归 InputBox 所有时才处理。 */
  acceptsInput?: (input: string, key: InputKey) => boolean;
  /** Enter 提交回调 */
  onSubmit: (text: string) => void;
}

export function InputBox({
  disabled,
  disabledLabel = "Running…",
  slashCommandSuggestions,
  slashArgumentSuggestions,
  fileMentionSuggestions,
  acceptsInput,
  onSubmit,
}: InputBoxProps): React.ReactNode {
  const initialController = useRef(createInputControllerState());
  const controllerRef = useRef(initialController.current);
  const suggestionRequestSeq = useRef(0);
  const [controller, setController] = useState(initialController.current);

  useInput((input, key) => {
    if (acceptsInput && !acceptsInput(input, key)) return;
    const suggestionOptions = {
      slashCommandSuggestions,
      slashArgumentSuggestions,
      fileMentionSuggestions,
    };
    const result = reduceInputControllerEvent(controllerRef.current, input, key, {
      disabled,
      ...suggestionOptions,
    });
    controllerRef.current = result.state;
    setController(result.state);
    if (result.submittedText === undefined && !disabled) {
      scheduleAsyncSuggestions({
        state: result.state,
        options: suggestionOptions,
        requestSeq: suggestionRequestSeq,
        controllerRef,
        setController,
      });
    }
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

function scheduleAsyncSuggestions({
  state,
  options,
  requestSeq,
  controllerRef,
  setController,
}: {
  state: InputControllerState;
  options: Pick<
    InputControllerOptions,
    "slashCommandSuggestions" | "slashArgumentSuggestions" | "fileMentionSuggestions"
  >;
  requestSeq: React.MutableRefObject<number>;
  controllerRef: React.MutableRefObject<InputControllerState>;
  setController: React.Dispatch<React.SetStateAction<InputControllerState>>;
}): void {
  const context = getSuggestionContext(state.text, state.cursor);
  if (!context) {
    requestSeq.current += 1;
    return;
  }

  const result = suggestionResultForContext(context, options);
  if (!isPromiseLike(result)) return;

  const requestId = ++requestSeq.current;
  void result.then((items) => {
    if (requestSeq.current !== requestId) return;

    const current = controllerRef.current;
    const currentContext = getSuggestionContext(current.text, current.cursor);
    if (!sameSuggestionContext(context, currentContext)) return;

    const activeSuggestions = buildAsyncSuggestionSession(context, items, current.activeSuggestions);
    const next = { ...current, activeSuggestions };
    controllerRef.current = next;
    setController(next);
  });
}

function suggestionResultForContext(
  context: NonNullable<ReturnType<typeof getSuggestionContext>>,
  options: Pick<
    InputControllerOptions,
    "slashCommandSuggestions" | "slashArgumentSuggestions" | "fileMentionSuggestions"
  >,
): SuggestionSourceResult {
  if (context.kind === "slash") {
    return options.slashCommandSuggestions?.(context.query) ?? [];
  }
  if (context.kind === "slash-argument") {
    return options.slashArgumentSuggestions?.(context.command ?? "", context.query) ?? [];
  }
  return options.fileMentionSuggestions?.(context.query) ?? [];
}

function buildAsyncSuggestionSession(
  context: NonNullable<ReturnType<typeof getSuggestionContext>>,
  items: readonly InputSuggestion[],
  current: ActiveSuggestionSession | null,
): ActiveSuggestionSession | null {
  if (items.length === 0) return null;
  const selectedIndex =
    current && sameSuggestionContext(context, current)
      ? Math.min(current.selectedIndex, items.length - 1)
      : 0;
  return {
    kind: context.kind,
    query: context.query,
    replaceStart: context.replaceStart,
    replaceEnd: context.replaceEnd,
    selectedIndex,
    items: [...items],
  };
}

function sameSuggestionContext(
  left: NonNullable<ReturnType<typeof getSuggestionContext>>,
  right:
    | NonNullable<ReturnType<typeof getSuggestionContext>>
    | ActiveSuggestionSession
    | null,
): boolean {
  return Boolean(
    right &&
      left.kind === right.kind &&
      left.query === right.query &&
      left.replaceStart === right.replaceStart &&
      left.replaceEnd === right.replaceEnd &&
      ("command" in right ? left.command === right.command : true),
  );
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(
    typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as { then?: unknown }).then === "function",
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
