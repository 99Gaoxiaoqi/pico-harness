// 输入框组件:用 ink 的 useInput 收集按键,累积成文本,Enter 提交。
// ink 没有内置 TextInput(ink-text-input 是独立包),这里自实现极简版,
// 避免再装一个依赖(对齐项目极简哲学)。
//
// 对标 Claude Code PromptInput,但极简化:
//   - 多行:Alt+Enter / Shift+Enter 插入换行,Enter 提交
//   - 输入历史:↑/↓ 翻最近 20 条(对标 onHistoryUp/Down)
//
// 支持:字符输入、Backspace 删除、Enter 提交、Ctrl+C 退出(由 App 层处理)。

import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

/** 历史记录上限(对标 Claude Code,极简保留最近 20 条) */
const HISTORY_MAX = 20;

export interface InputBoxProps {
  /** 禁用状态(模型运行中) */
  disabled?: boolean;
  /** Enter 提交回调 */
  onSubmit: (text: string) => void;
}

export function InputBox({ disabled, onSubmit }: InputBoxProps): React.ReactNode {
  const [text, setText] = useState("");
  // 输入历史:每次提交追加一条,最近 HISTORY_MAX 条。用 useRef 避免重渲染。
  const historyRef = useRef<string[]>([]);
  // 当前历史浏览游标(指向历史栈中的索引;null 表示不在浏览中,正在写新内容)
  const historyIdxRef = useRef<number | null>(null);
  // 浏览历史前的草稿(按 ↑ 进入历史前,保存当前正在输入的内容,↓ 退回时还原)
  const draftRef = useRef<string>("");

  useInput((input, key) => {
    if (disabled) return;

    // Alt+Enter / Shift+Enter:插入换行(多行输入)。
    // ink 的 Key 无独立 alt 字段,Alt 记为 meta(终端 Alt→ESC 前缀→meta)。
    if (key.return && (key.meta || key.shift)) {
      setText((prev) => prev + "\n");
      return;
    }

    if (key.return) {
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
        pushHistory(historyRef.current, trimmed);
      }
      setText("");
      historyIdxRef.current = null; // 提交后退出历史浏览
      draftRef.current = "";
      return;
    }

    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1));
      return;
    }

    // 历史:↑ 向更旧翻,↓ 向更新翻(仅在单行末尾或全程允许,极简:全程允许)。
    const history = historyRef.current;
    if (key.upArrow && history.length > 0) {
      // 首次按 ↑:记录当前草稿,游标定位到最新一条
      if (historyIdxRef.current === null) {
        draftRef.current = text;
        historyIdxRef.current = history.length - 1;
      } else if (historyIdxRef.current > 0) {
        historyIdxRef.current -= 1;
      }
      setText(history[historyIdxRef.current] ?? "");
      return;
    }
    if (key.downArrow && historyIdxRef.current !== null) {
      if (historyIdxRef.current < history.length - 1) {
        historyIdxRef.current += 1;
        setText(history[historyIdxRef.current] ?? "");
      } else {
        // 已到最新之后:还原草稿,退出历史浏览
        historyIdxRef.current = null;
        setText(draftRef.current);
      }
      return;
    }

    // 普通可打印字符(过滤控制字符)
    if (input && !key.ctrl && !key.meta && !key.shift && input.length === 1 && input >= " ") {
      // 用户手动改字 → 退出历史浏览
      historyIdxRef.current = null;
      setText((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green" bold>
          ❯{" "}
        </Text>
        {disabled ? (
          <Text dimColor>模型运行中,请等待…</Text>
        ) : text.includes("\n") ? (
          // 多行:逐行渲染,光标 ▋ 在最后一行末尾
          <Box flexDirection="column">
            {text.split("\n").map((line, i, lines) => (
              <Text key={i}>
                {line}
                {i === lines.length - 1 ? <Text color="gray">▋</Text> : null}
              </Text>
            ))}
          </Box>
        ) : (
          <Text>
            {text}
            <Text color="gray">▋</Text>
          </Text>
        )}
      </Box>
      {!disabled && (
        <Text dimColor> Enter 发送 · Alt/Shift+Enter 换行 · ↑/↓ 历史</Text>
      )}
    </Box>
  );
}

/** 追加一条历史,超出上限时丢弃最旧的(环形保留最近 HISTORY_MAX 条)。 */
function pushHistory(history: string[], entry: string): void {
  // 与上一条相同则不重复(对标 shell 行为)
  if (history[history.length - 1] === entry) return;
  history.push(entry);
  if (history.length > HISTORY_MAX) history.shift();
}
