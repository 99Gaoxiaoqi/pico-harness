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

import React, { memo } from "react";
import { Box, useApp, useInput } from "ink";
import { appendFileSync } from "node:fs";
import { InputBox } from "./input-box.js";
import type { SuggestionSource } from "./input-controller.js";
import { LogoPanel } from "./logo-panel.js";
import { Spinner } from "./spinner.js";
import type { SpinnerMode } from "./spinner.js";
import { MessageList } from "./message-list.js";
import { StatusBar } from "./status-bar.js";
import type { TuiEntry } from "./tui-reporter.js";

/** 诊断日志:写文件(绕过 ink patchConsole 劫持),只在 TUI_DEBUG 时 */
function dbg(msg: string): void {
  if (process.env.TUI_DEBUG) {
    appendFileSync(".claw/tui-debug.log", `${new Date().toISOString()} ${msg}\n`);
  }
}

export interface AppProps {
  /** 模型名(Logo 展示) */
  model: string;
  /** Provider 名称(状态区展示) */
  provider?: string;
  /** 工作区(Logo 展示) */
  workDir: string;
  /** Session 选择模式(状态区展示) */
  sessionMode?: string;
  /** 当前对话流条目(reporter 增量更新) */
  entries: TuiEntry[];
  /** 是否正在运行(idle 时聚焦输入框) */
  running: boolean;
  /** Slash command 候选源 */
  slashCommandSuggestions?: SuggestionSource;
  /** @ 文件候选源 */
  fileMentionSuggestions?: SuggestionSource;
  /** 用户提交一条消息时触发(repl 调 engine.run) */
  onSubmit: (text: string) => void;
}

export function App({
  model,
  provider = "openai",
  workDir,
  sessionMode = "new",
  entries,
  running,
  slashCommandSuggestions,
  fileMentionSuggestions,
  onSubmit,
}: AppProps): React.ReactNode {
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

  // 诊断:记录每次渲染的 entries 状态
  dbg(`render: entries=${entries.length} running=${running} streaming=${isStreaming}`);
  entries.forEach((e, i) => {
    const c = e.kind === "user" || e.kind === "assistant" ? e.content.slice(0, 40) : e.kind;
    dbg(`  [${i}] ${e.kind}: ${c}`);
  });

  return (
    <Box flexDirection="column">
      {/* Claude Code 风格:Logo 与状态区是稳定首块,不随 messages 数组变化而重新脏化整棵消息树。 */}
      <StableLogoPanel />
      <StatusBar model={model} provider={provider} cwd={workDir} sessionMode={sessionMode} />

      {/* 消息列表:统一走 MessageList,由 shouldRenderStatically + MessageRow.memo 控制静态行。 */}
      <Box flexDirection="column" paddingX={1}>
        <MessageList entries={entries} isStreaming={isStreaming} />
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
        <InputBox
          disabled={running}
          slashCommandSuggestions={slashCommandSuggestions}
          fileMentionSuggestions={fileMentionSuggestions}
          onSubmit={onSubmit}
        />
      </Box>
    </Box>
  );
}

const StableLogoPanel = memo(LogoPanel);

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
