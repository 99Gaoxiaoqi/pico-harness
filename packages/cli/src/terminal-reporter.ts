import pc from "picocolors";
import type { Reporter, ToolResultEnvelope } from "@pico/core";

const diffColors = pc.createColors(true);

/** CLI 的终端运行展示实现。 */
export class TerminalReporter implements Reporter {
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private spinnerIdx = 0;

  onStart(workDir: string): void {
    console.log(`[Engine] 引擎启动,锁定工作区: ${workDir}`);
  }

  onTurnStart(turn: number): void {
    console.log(`\n========== [Turn ${turn}] 开始 ==========`);
  }

  onThinking(): void {
    console.log("[Engine] 思考中...");
    this.startSpinner();
  }

  onThinkingEnd(): void {
    this.stopSpinner();
  }

  onToolCall(toolName: string, args: string): void {
    this.stopSpinner();
    console.log(`    -> 🛠️ 执行工具: ${toolName}, 参数: ${args}`);
  }

  onToolResult(result: ToolResultEnvelope): void {
    this.stopSpinner();
    if (result.status !== "succeeded") {
      console.log(pc.red(`    -> ❌ 工具执行报错: ${result.projection.text.slice(0, 200)}`));
      return;
    }
    const allLines = result.projection.text.split("\n");
    const lines = allLines.slice(0, 3).map((line) => line.slice(0, 100));
    const summary = lines.join("\n    | ");
    const more = allLines.length > 3 ? `\n    | ... (共 ${allLines.length} 行)` : "";
    console.log(pc.green(`    -> ✅ ${result.toolName}`) + ` (返回 ${result.rawSizeBytes} 字节)`);
    if (summary.trim()) console.log(pc.dim(`    | ${summary}${more}`));
  }

  onMessage(content: string): void {
    this.stopSpinner();
    console.log(`🤖 [对外回复]: ${content}`);
  }

  onFinish(): void {
    this.stopSpinner();
    console.log("[Engine] 模型未请求调用工具,任务宣告完成。");
  }

  onInterrupted(): void {
    this.stopSpinner();
  }

  onTextDelta(delta: string): void {
    this.stopSpinner();
    process.stdout.write(delta);
  }

  onReasoningDelta(delta: string): void {
    this.stopSpinner();
    process.stdout.write(pc.dim(delta));
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerIdx % this.spinnerFrames.length]!;
      process.stdout.write(`\r${pc.cyan(frame)} 思考中...`);
      this.spinnerIdx++;
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      process.stdout.write("\r\x1b[K");
    }
  }
}

/** diff 文本按行着色；终端宿主可复用。 */
export function colorizeDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return diffColors.green(line);
      if (line.startsWith("-")) return diffColors.red(line);
      if (line.startsWith("@@")) return diffColors.cyan(line);
      return diffColors.dim(line);
    })
    .join("\n");
}
