import type { CanonicalTranscriptToolStart, Reporter, ToolResultEnvelope } from "@pico/core";

/** 无副作用的 Reporter，供后台执行、测试和无展示宿主复用。 */
export class SilentReporter implements Reporter {
  onStart(): void {}
  onTurnStart(): void {}
  onThinking(): void {}
  onToolCall(
    _toolName: string,
    _args: string,
    _providerCallId: string,
    _durableStart?: CanonicalTranscriptToolStart,
  ): void {}
  onToolResult(_result: ToolResultEnvelope): void {}
  onMessage(): void {}
  onFinish(): void {}
}
