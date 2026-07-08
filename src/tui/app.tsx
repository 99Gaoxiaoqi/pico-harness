// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React)。
// 布局:顶栏(model/workDir) → 消息列表 → 输入框。
// 状态机:idle(可输入) | thinking(模型运行中,输入框禁用)。
//
// 由 repl.ts 调用 ink render(<App ... />) 挂载。
// engine 事件经 TuiReporter → onUpdate → setState 驱动重渲染。

import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { MessageList } from "./message-list.js";
import { InputBox } from "./input-box.js";
import { Spinner } from "./spinner.js";
import type { TuiEntry } from "./tui-reporter.js";

export interface AppProps {
  /** 模型名(顶栏展示) */
  model: string;
  /** 工作区(顶栏展示) */
  workDir: string;
  /** 当前对话流条目(reporter 增量更新) */
  entries: TuiEntry[];
  /** 是否正在运行(idle 时聚焦输入框) */
  running: boolean;
  /** 用户提交一条消息时触发(repl 调 engine.run) */
  onSubmit: (text: string) => void;
}

export function App({ model, workDir, entries, running, onSubmit }: AppProps): React.ReactNode {
  const { exit } = useApp();

  // Ctrl+C 退出(ink 默认不绑,需手动)
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* 顶栏 */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          pico
        </Text>
        <Text dimColor>
          {" · "}
          {model} · {workDir}
        </Text>
      </Box>

      {/* 消息列表(占满剩余空间) */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <MessageList entries={entries} />
        {/* 思考中 spinner:running 且末尾是 thinking 条目时显示 */}
        {running && entries[entries.length - 1]?.kind === "thinking" && (
          <Box>
            <Spinner label="思考中" />
          </Box>
        )}
      </Box>

      {/* 输入框:running 时禁用 */}
      <Box borderStyle="round" borderColor={running ? "gray" : "green"} paddingX={1}>
        <InputBox disabled={running} onSubmit={onSubmit} />
      </Box>

      {/* 底部提示 */}
      <Text dimColor> Enter 发送 · Ctrl+C 退出</Text>
    </Box>
  );
}
