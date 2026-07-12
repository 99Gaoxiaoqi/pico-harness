// 输入框组件:用 ink 的 useInput 收集按键,累积成文本,Enter 提交。
// ink 没有内置 TextInput(ink-text-input 是独立包),这里自实现极简版,
// 避免再装一个依赖(对齐项目极简哲学)。
//
// 对标 Claude Code PromptInput,但极简化:
//   - 多行:Alt+Enter / Shift+Enter 插入换行,Enter 提交
//   - 输入历史:↑/↓ 翻最近 20 条(对标 onHistoryUp/Down)
//
// 支持:字符输入、基础光标编辑、Backspace/Delete、Enter 提交、Ctrl+C 退出(由 App 层处理)。

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  createInputControllerState,
  getSuggestionContext,
  reduceInputControllerEvent,
  type InputControllerState,
  type InputKey,
  type PendingSuggestionRequest,
  type SlashArgumentSuggestionSource,
  type SuggestionSource,
} from "./input-controller.js";
import type { ActiveSuggestionSession, InputSuggestion } from "./suggestions.js";
import { SuggestionList } from "./suggestions.js";
import type { UserKeybindingConfig } from "./keybindings/resolver.js";
import {
  droppedImagePath,
  imageAttachmentFromClipboard,
  imageAttachmentFromPath,
  type InputImageAttachment,
} from "./image-attachments.js";

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
  /** 将当前草稿同步给顶层焦点仲裁。 */
  onTextChange?: (text: string) => void;
  /** 将会影响焦点仲裁的输入状态同步给顶层。 */
  onStateChange?: (snapshot: InputBoxStateSnapshot) => void;
  /** Enter 提交回调 */
  onSubmit: (submission: InputBoxSubmission) => void;
  /** User overrides loaded from .pico/config.json. */
  keybindings?: UserKeybindingConfig;
  /** /rewind 等外部动作请求原子替换当前草稿。 */
  inputReplacement?: { sequence: number; text: string };
}

export interface InputBoxSubmission {
  readonly text: string;
  readonly attachments: readonly InputImageAttachment[];
}

export interface InputBoxStateSnapshot {
  text: string;
  hasSuggestions: boolean;
  historyIndex: number | null;
}

export function InputBox({
  disabled,
  disabledLabel = "Running…",
  slashCommandSuggestions,
  slashArgumentSuggestions,
  fileMentionSuggestions,
  acceptsInput,
  onTextChange,
  onStateChange,
  onSubmit,
  keybindings,
  inputReplacement,
}: InputBoxProps): React.ReactNode {
  const initialController = useRef(createInputControllerState());
  const controllerRef = useRef(initialController.current);
  const suggestionRequestSeq = useRef(0);
  const appliedReplacementSequence = useRef<number | undefined>(undefined);
  const attachingImage = useRef(false);
  const mounted = useRef(true);
  const [controller, setController] = useState(initialController.current);
  const [attachments, setAttachments] = useState<readonly InputImageAttachment[]>([]);
  const [attachmentNotice, setAttachmentNotice] = useState<string | undefined>(undefined);

  useEffect(
    () => () => {
      mounted.current = false;
      suggestionRequestSeq.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!inputReplacement) return;
    if (appliedReplacementSequence.current === inputReplacement.sequence) return;
    appliedReplacementSequence.current = inputReplacement.sequence;
    const next: InputControllerState = {
      ...controllerRef.current,
      text: inputReplacement.text,
      cursor: inputReplacement.text.length,
      activeSuggestions: null,
      historyIndex: null,
      draft: "",
    };
    controllerRef.current = next;
    setController(next);
    onTextChange?.(next.text);
    onStateChange?.(inputBoxStateSnapshot(next));
  }, [inputReplacement, onStateChange, onTextChange]);

  useEffect(() => {
    onStateChange?.(inputBoxStateSnapshot(controllerRef.current));
  }, [onStateChange]);

  useInput((input, key) => {
    if (acceptsInput && !acceptsInput(input, key)) return;
    if (isImagePasteShortcut(input, key)) {
      void attachImage(() => imageAttachmentFromClipboard());
      return;
    }
    if (key.ctrl && key.backspace && attachments.length > 0) {
      setAttachments((current) => current.slice(0, -1));
      setAttachmentNotice(undefined);
      return;
    }
    const previousText = controllerRef.current.text;
    const suggestionOptions = {
      slashCommandSuggestions,
      slashArgumentSuggestions,
      fileMentionSuggestions,
    };
    const result = reduceInputControllerEvent(controllerRef.current, input, key, {
      disabled,
      keybindings,
      ...suggestionOptions,
    });
    controllerRef.current = result.state;
    setController(result.state);
    if (result.state.text !== previousText) onTextChange?.(result.state.text);
    onStateChange?.(inputBoxStateSnapshot(result.state));
    const droppedPath = droppedImagePath(result.state.text);
    if (droppedPath !== undefined)
      void attachImage(
        () => Promise.resolve(imageAttachmentFromPath(droppedPath)),
        result.state.text,
      );
    if (result.submittedText === undefined && !disabled && result.pendingSuggestion) {
      scheduleAsyncSuggestions({
        pending: result.pendingSuggestion,
        requestSeq: suggestionRequestSeq,
        mounted,
        controllerRef,
        setController,
        onStateChange,
      });
    }
    const attachmentOnlySubmission =
      result.submittedText === undefined &&
      key.return === true &&
      !key.meta &&
      !key.shift &&
      attachments.length > 0 &&
      result.state.text.trim().length === 0;
    if (result.submittedText !== undefined || attachmentOnlySubmission) {
      onSubmit({ text: result.submittedText ?? "请查看这张图片。", attachments });
      setAttachments([]);
      setAttachmentNotice(undefined);
    }
  });

  function attachImage(loader: () => Promise<InputImageAttachment>, clearText?: string): void {
    if (attachingImage.current) return;
    attachingImage.current = true;
    void loader()
      .then((attachment) => {
        if (!mounted.current) return;
        setAttachments((current) => [...current, attachment]);
        setAttachmentNotice(`已附加图片: ${attachment.name}`);
        if (clearText !== undefined && controllerRef.current.text === clearText) {
          const next = {
            ...controllerRef.current,
            text: "",
            cursor: 0,
            activeSuggestions: null,
            historyIndex: null,
            draft: "",
          };
          controllerRef.current = next;
          setController(next);
          onTextChange?.(next.text);
          onStateChange?.(inputBoxStateSnapshot(next));
        }
      })
      .catch((error) => {
        if (!mounted.current) return;
        setAttachmentNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        attachingImage.current = false;
      });
  }

  const { text, cursor, activeSuggestions } = controller;

  return (
    <Box flexDirection="column">
      {renderInputPrompt({ disabled: Boolean(disabled), disabledLabel, text, cursor })}
      {attachments.length > 0 && (
        <Text color="cyan">
          📎 {attachments.map((attachment) => attachment.name).join(", ")} · Ctrl+Backspace
          移除最后一张
        </Text>
      )}
      {attachmentNotice && <Text color="gray">{attachmentNotice}</Text>}
      {!disabled && <SuggestionList session={activeSuggestions} />}
    </Box>
  );
}

function isImagePasteShortcut(input: string, key: InputKey): boolean {
  return key.ctrl === true && (input === "v" || input === "V" || input === "\u0016");
}

function scheduleAsyncSuggestions({
  pending,
  requestSeq,
  mounted,
  controllerRef,
  setController,
  onStateChange,
}: {
  pending: PendingSuggestionRequest;
  requestSeq: React.MutableRefObject<number>;
  mounted: React.MutableRefObject<boolean>;
  controllerRef: React.MutableRefObject<InputControllerState>;
  setController: React.Dispatch<React.SetStateAction<InputControllerState>>;
  onStateChange?: (snapshot: InputBoxStateSnapshot) => void;
}): void {
  const requestId = ++requestSeq.current;
  void pending.result
    .then((items) => {
      if (!mounted.current) return;
      if (requestSeq.current !== requestId) return;

      const current = controllerRef.current;
      const currentContext = getSuggestionContext(current.text, current.cursor);
      if (!sameSuggestionContext(pending.context, currentContext)) return;

      const activeSuggestions = buildAsyncSuggestionSession(
        pending.context,
        items,
        current.activeSuggestions,
      );
      const next = { ...current, activeSuggestions };
      controllerRef.current = next;
      setController(next);
      onStateChange?.(inputBoxStateSnapshot(next));
    })
    .catch(() => {
      if (!mounted.current || requestSeq.current !== requestId) return;
    });
}

export function inputBoxStateSnapshot(state: InputControllerState): InputBoxStateSnapshot {
  return {
    text: state.text,
    hasSuggestions: state.activeSuggestions !== null,
    historyIndex: state.historyIndex,
  };
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
  right: NonNullable<ReturnType<typeof getSuggestionContext>> | ActiveSuggestionSession | null,
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
