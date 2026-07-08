// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React)。
// 布局:顶栏 → <Static 历史消息> → 动态区(流式输出/spinner/输入框)。
//
// 关键架构(对标 Claude Code):用 ink 的 <Static> 组件渲染已完成的历史消息,
// 这些内容被一次性输出到 stdout 并固定(像 console.log 一样滚动出去),
// 不参与 ink 的重渲染区域——因此无论对话多长都不会被截断。
// 动态区只保留"正在进行中"的内容(当前流式回复/running 工具/spinner/输入框),
// 高度很小,不会被终端高度截断。
//
// 状态机:idle(可输入) | thinking(模型运行中,输入框禁用)。

import React from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
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

  // 分割:已完成的历史条目(放 Static,永久输出不截断) vs 进行中的条目(留动态区)
  // 规则:除"最后一条仍在变化"的条目外,都已固定。
  //   - running 状态的 tool 卡片:进行中
  //   - 正在流式累积的 assistant(末尾且 running):进行中
  //   - thinking 占位:进行中(spinner 显示)
  // 其余(user/已完成的 tool/已固化的 assistant):历史,放 Static。
  const { staticEntries, liveEntries } = splitStatic(entries, running);

  return (
    <Box flexDirection="column">
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

      {/* 历史消息:Static 一次性输出到 stdout,滚动出去,不占重渲染区,不被截断 */}
      <Static items={staticEntries}>
        {(entry, i) => <MessageList key={i} entries={[entry]} />}
      </Static>

      {/* 动态区:进行中的内容(高度小,不会被终端高度截断) */}
      {liveEntries.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <MessageList entries={liveEntries} />
        </Box>
      )}

      {/* 思考中 spinner */}
      {running && liveEntries[liveEntries.length - 1]?.kind === "thinking" && (
        <Box paddingX={1}>
          <Spinner label="思考中" />
        </Box>
      )}

      {/* 输入框:running 时禁用 */}
      <Box borderStyle="round" borderColor={running ? "gray" : "green"} paddingX={1}>
        <InputBox disabled={running} onSubmit={onSubmit} />
      </Box>

      {/* 底部提示 */}
      <Text dimColor> Enter 发送 · Ctrl+C 退出</Text>
    </Box>
  );
}

/**
 * 把 entries 分成"已固定的历史"和"进行中"两组。
 * 进行中 = 末尾连续的、仍可能变化的条目(tool running / 流式 assistant / thinking)。
 */
function splitStatic(
  entries: TuiEntry[],
  running: boolean,
): { staticEntries: TuiEntry[]; liveEntries: TuiEntry[] } {
  if (entries.length === 0) return { staticEntries: [], liveEntries: [] };

  // 从末尾向前找第一个"已固定"的条目,它之后的全是 live
  let splitIdx = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const isLive =
      running &&
      (e.kind === "thinking" ||
        (e.kind === "tool" && e.status === "running") ||
        // 末尾的 assistant 且本轮仍在流式(running 时最后一条 assistant 视为流式中)
        (e.kind === "assistant" && i === entries.length - 1));
    if (isLive) {
      splitIdx = i;
    } else {
      break; // 遇到第一个已固定的就停(前面的都是历史)
    }
  }
  return {
    staticEntries: entries.slice(0, splitIdx),
    liveEntries: entries.slice(splitIdx),
  };
}
