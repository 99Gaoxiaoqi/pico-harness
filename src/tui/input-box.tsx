// 输入框组件:用 ink 的 useInput 收集按键,累积成文本,Enter 提交。
// ink 没有内置 TextInput(ink-text-input 是独立包),这里自实现极简版,
// 避免再装一个依赖(对齐项目极简哲学)。
//
// 支持:字符输入、Backspace 删除、Enter 提交、Ctrl+C 退出(由 App 层处理)。

import React, { useState } from "react";
import { Text, useInput } from "ink";

export interface InputBoxProps {
  /** 禁用状态(模型运行中) */
  disabled?: boolean;
  /** Enter 提交回调 */
  onSubmit: (text: string) => void;
}

export function InputBox({ disabled, onSubmit }: InputBoxProps): React.ReactNode {
  const [text, setText] = useState("");

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      const trimmed = text.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setText("");
      }
      return;
    }

    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1));
      return;
    }

    // 普通可打印字符(过滤控制字符)
    if (input && !key.ctrl && !key.meta && input.length === 1 && input >= " ") {
      setText((prev) => prev + input);
    }
  });

  return (
    <Text>
      <Text color="green" bold>
        ❯{" "}
      </Text>
      {disabled ? (
        <Text dimColor>模型运行中,请等待…</Text>
      ) : (
        <Text>
          {text}
          <Text color="gray">▋</Text>
        </Text>
      )}
    </Text>
  );
}
