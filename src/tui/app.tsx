// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React 19)。
// 布局:LogoHeader(首项) → 消息列表(全部条目,React.memo 跳过静态) → spinner → 输入框。
//
// 关键架构(对标 Claude Code):
//   不用 ink 的 <Static> 组件——它会让条目从 live 区"毕业"到 static 区时,
//   在终端产生重复(动态区残留 + static 新行)。Claude Code 同款不用 Static,
//   而是把所有条目留在同一渲染树,用 React.memo(isStatic 时跳过重渲染)。
//   性能靠"静态条目 memo 后零 diff"保证,不靠 Static 输出到 scrollback。
//
// 对标改动:
//   1. 去掉 <Static>,所有条目在同一 <Box>,isStatic 仅作 memo 提示
//   2. 去固定顶栏 → LogoHeader 作为消息流首项
//   3. Spinner 用 SpinnerMode:据末尾条目状态切阶段
//   4. 输入框 borderBottom only(对标 PromptInput)
//
// 状态机:idle(可输入) | running(模型运行中,输入框禁用)。

import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { InputBox } from "./input-box.js";
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { LogoHeader, MessageList, shouldRenderStatically } from "./message-list.js";
import { MessageRow } from "./message-row.js";
import type { TuiEntry } from "./tui-reporter.js";

export interface AppProps {
  /** 模型名(Logo 展示) */
  model: string;
  /** 工作区(Logo 展示) */
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

  // 是否仍有"主动流式":running 且末尾是流式 assistant / thinking / running tool
  const isStreaming = running && isActivelyStreaming(entries);
  // spinner 阶段:据末尾条目状态选
  const spinnerMode = pickSpinnerMode(entries, isStreaming);

  return (
    <Box flexDirection="column">
      {/* Logo(消息流首项,对标 Claude Code 无常驻顶栏) */}
      <LogoHeader model={model} workDir={workDir} />

      {/* 消息列表:全部条目在同一渲染树。
          isStatic 的条目由 MessageRow 的 React.memo 跳过重渲染(零 diff)。
          不用 <Static>(会导致条目毕业时终端重复渲染)。 */}
      <Box flexDirection="column" paddingX={1}>
        {entries.map((entry, i) => {
          const isLast = i === entries.length - 1;
          const isStatic = shouldRenderStatically(entry, isLast, isStreaming);
          return <MessageRow key={i} entry={entry} isStatic={isStatic} isLast={isLast} />;
        })}
      </Box>

      {/* 思考/spinner:据末尾状态显示对应 mode */}
      {running && (
        <Box paddingX={1}>
          <Spinner mode={spinnerMode} />
        </Box>
      )}

      {/* 输入框:仅底边(对标 PromptInput),running 时禁用。 */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={running ? "gray" : "green"}
        paddingX={1}
      >
        <InputBox disabled={running} onSubmit={onSubmit} />
      </Box>

      {/* 底部提示 */}
      <Text dimColor> Enter 发送 · Ctrl+C 退出</Text>
    </Box>
  );
}

/**
 * 判断当前是否"主动流式":末尾是流式 assistant,或 thinking/running tool 占位。
 * 用于区分 SpinnerMode 和 isStreaming。
 */
function isActivelyStreaming(entries: TuiEntry[]): boolean {
  const last = entries[entries.length - 1];
  if (!last) return false;
  // assistant 末条仍在累积 / thinking 占位 / running tool 都算"进行中"
  return last.kind === "assistant" || last.kind === "thinking" || (last.kind === "tool" && last.status === "running");
}

/**
 * 据 liveEntries 末尾状态选 SpinnerMode(对标 Claude Code 各阶段文案):
 *   - thinking           → "thinking"
 *   - running tool       → "tool-use"
 *   - assistant 流式中   → "responding"
 *   - 无 delta/其他      → "requesting"(等首包)
 */
function pickSpinnerMode(liveEntries: TuiEntry[], isStreaming: boolean): SpinnerMode {
  const last = liveEntries[liveEntries.length - 1];
  if (!last) return "requesting";
  if (last.kind === "thinking") return "thinking";
  if (last.kind === "tool" && last.status === "running") return "tool-use";
  if (last.kind === "assistant" && isStreaming) return "responding";
  return "requesting";
}
