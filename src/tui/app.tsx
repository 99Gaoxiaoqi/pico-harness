// TUI 顶层组件:对标 Claude Code 的 App.tsx(ink + React 19)。
// 布局:LogoHeader(消息流首项) → <Static 历史消息> → 动态区(流式输出/spinner/输入框)。
//
// 关键架构(对标 Claude Code):用 ink 的 <Static> 组件渲染已完成的历史消息,
// 这些内容被一次性输出到 stdout 并固定(像 console.log 一样滚动出去),
// 不参与 ink 的重渲染区域——因此无论对话多长都不会被截断。
// 动态区只保留"正在进行中"的内容(当前流式回复/running 工具/spinner/输入框),
// 高度很小,不会被终端高度截断。
//
// 对标改动(深度对标 Claude Code):
//   1. 去掉固定 borderStyle="round" 顶栏 → LogoHeader 作为消息流首项(非常驻)
//   2. Static/live 分割改用 shouldRenderStatically(按 tool resolve 状态判,
//      而非末尾连续切分),逐条判 isStatic
//   3. Spinner 用新的 SpinnerMode:据动态区末尾状态切 mode
//   4. 输入框改为 borderBottom only(对标 PromptInput)
//
// 状态机:idle(可输入) | running(模型运行中,输入框禁用)。

import React from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
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

/** 进 <Static> 的条目:首项固定是 Logo,其后是 TuiEntry。logo 用标记字段区分。 */
type StaticItem =
  | { kind: "logo"; model: string; workDir: string }
  | (TuiEntry & { kind: Exclude<TuiEntry["kind"], "logo"> });

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
  // 逐条判 isStatic,分割成 static(进 <Static>)和 live(动态区)两组
  const { staticEntries, liveEntries } = partitionByStatic(entries, isStreaming);
  // Logo 作为 Static 首项(非常驻,只在历史区出现一次)
  const staticItems: StaticItem[] = [{ kind: "logo", model, workDir }, ...staticEntries];
  // 据动态区末尾状态选 SpinnerMode
  const spinnerMode = pickSpinnerMode(liveEntries, isStreaming);

  return (
    <Box flexDirection="column">
      {/* 历史消息:Static 一次性输出到 stdout,滚动出去,不占重渲染区,不被截断。
          items[0] 是 LogoHeader(消息流首项,对标 Claude Code 无常驻顶栏)。 */}
      <Static items={staticItems}>
        {(item, i) => {
          if (item.kind === "logo") {
            return <LogoHeader key="logo" model={item.model} workDir={item.workDir} />;
          }
          // isLast 仅对动态区为空时的 Static 末条生效(供 ToolCard 默认折叠判断)
          const isLast = liveEntries.length === 0 && i === staticItems.length - 1;
          return <MessageRow key={i} entry={item} isStatic={true} isLast={isLast} />;
        }}
      </Static>

      {/* 动态区:进行中的内容(高度小,不会被终端高度截断) */}
      {liveEntries.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          <MessageList entries={liveEntries} isStreaming={isStreaming} />
        </Box>
      )}

      {/* 思考/spinner:据 liveEntries 末尾状态显示对应 mode(对标 Claude Code SpinnerAnimationRow) */}
      {running && (
        <Box paddingX={1}>
          <Spinner mode={spinnerMode} />
        </Box>
      )}

      {/* 输入框:仅底边(对标 PromptInput),running 时禁用。
          ink 部分边框需先设 borderStyle,再用 borderTop/Left/Right=false 关掉其余三边。 */}
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
 * 按 shouldRenderStatically 把 entries 分成 static / live 两组。
 * 与原 splitStatic 不同:这里是"逐条判",而非"末尾连续切分",
 * 与 Claude Code shouldRenderStatically 的逐条 resolve 判定一致。
 */
function partitionByStatic(
  entries: TuiEntry[],
  isStreaming: boolean,
): { staticEntries: TuiEntry[]; liveEntries: TuiEntry[] } {
  const staticItems: TuiEntry[] = [];
  const live: TuiEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const isLast = i === entries.length - 1;
    if (shouldRenderStatically(e, isLast, isStreaming)) {
      staticItems.push(e);
    } else {
      live.push(e);
    }
  }
  return { staticEntries: staticItems, liveEntries: live };
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
