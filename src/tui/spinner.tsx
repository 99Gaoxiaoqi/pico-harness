// Spinner:思考动画,用 ink 7 的 useAnimation 驱动(对标 Claude Code SpinnerAnimationRow)。
//
// 性能关键:useAnimation 的 frame 状态自包含在本组件内,
// 不触发父组件(App/MessageList)setState。��个 spinner 共享单一 timer
// (ink 内部合并),避免全局重渲染。
//
// SpinnerMode(对标 Claude Code types.ts):随引擎阶段切换文案:
//   requesting — 等首包("请求中…")
//   thinking    — 慢思考("思考中…")
//   tool-use    — 工具执行("执行工具中…")
//   responding  — 流式输出("生成回复中…")

import React from "react";
import { Text, useAnimation } from "ink";

export type SpinnerMode = "requesting" | "thinking" | "tool-use" | "responding";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⎇", "⠏"];

/** 各阶段文案 */
const MODE_LABEL: Record<SpinnerMode, string> = {
  requesting: "请求中",
  thinking: "思考中",
  "tool-use": "执行工具中",
  responding: "生成回复中",
};

/** 各阶段颜色(thinking 用 magenta 突出,其余 cyan) */
const MODE_COLOR: Record<SpinnerMode, string> = {
  requesting: "cyan",
  thinking: "magenta",
  "tool-use": "yellow",
  responding: "green",
};

export function Spinner({
  mode = "thinking",
  interval = 80,
}: {
  mode?: SpinnerMode;
  /** 动画帧间隔 ms,默认 80(与原 TerminalReporter 一致) */
  interval?: number;
}): React.ReactNode {
  // useAnimation:frame 状态自包含,不冒泡到父组件。isActive=false 时停止(省 CPU)。
  const { frame } = useAnimation({ interval, isActive: true });
  const glyph = FRAMES[frame % FRAMES.length]!;
  return (
    <Text color={MODE_COLOR[mode]}>
      {glyph} {MODE_LABEL[mode]}…
    </Text>
  );
}
