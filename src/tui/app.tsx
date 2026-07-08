// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React 19)。
// 布局:LogoHeader → 消息列表(全部条目,React.memo 跳过静态) → spinner → 输入框。
//
// 关键架构(三路子代理排查确认):
//   不用 ink 的 <Static> 组件——它靠 items.length 追踪已渲染项,当条目在
//   live/static 间迁移导致 Static 子树节点身份变化时,reconciler 会清空
//   fullStaticOutput 并把所有历史条目重新裸写到 stdout,产生滚雪球重复。
//   Claude Code 也不用 <Static>(源码确认),靠差分渲染 + alt screen。
//
//   正确方案:所有条目留同一渲染树,用 React.memo(MessageRow 已有)跳过静态条目。
//   配合 render() 的 alternateScreen:true(进入 alt buffer,内容不进 scrollback,
//   退出时恢复主屏),彻底杜绝重复输出。
//   alt buffer 下 ink 只重绘可视区域(差分渲染),历史条目靠 React.memo 零 diff。

import React from "react";
import { Box, Text, useApp, useInput } from "ink";
import { InputBox } from "./input-box.js";
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { LogoHeader, shouldRenderStatically } from "./message-list.js";
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

  // Ctrl+C 退出(ink 默认不���,需手动)
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
      {/* Logo(消息流首项)。alt screen 模式下它随每帧重绘,但差分渲染只写变化 cell,不重复 */}
      <LogoHeader model={model} workDir={workDir} />

      {/* 消息列表:全部条目在同一渲染树(不用 <Static>)。
          React.memo(MessageRow) 跳过静态条目的重渲染(零 diff)。
          稳定 key:用 entries 的索引(条目只追加不重排,索引天然稳定)。 */}
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
 */
function isActivelyStreaming(entries: TuiEntry[]): boolean {
  const last = entries[entries.length - 1];
  if (!last) return false;
  return (
    last.kind === "assistant" ||
    last.kind === "thinking" ||
    (last.kind === "tool" && last.status === "running")
  );
}

/** 据 entries 末尾状态选 SpinnerMode */
function pickSpinnerMode(entries: TuiEntry[], isStreaming: boolean): SpinnerMode {
  const last = entries[entries.length - 1];
  if (!last) return "requesting";
  if (last.kind === "thinking") return "thinking";
  if (last.kind === "tool" && last.status === "running") return "tool-use";
  if (last.kind === "assistant" && isStreaming) return "responding";
  return "requesting";
}
