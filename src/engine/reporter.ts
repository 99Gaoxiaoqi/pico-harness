// Reporter 接口:引擎与输入输出 (I/O) 的彻底解耦。
// 对应课程第 09 讲 internal/engine/reporter.go。
//
// 设计哲学(类比 Linux):内核只负责调度运算,显示交给终端设备。
// 引擎不该关心自己在哪运行,只在生命周期节点向外"广播"事件。
// 注入不同实现即可切换展现层:TerminalReporter(CLI)/ WebReporter(HTTP)等。

import pc from "picocolors";

const diffColors = pc.createColors(true);

export type SubagentActivityStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "timed_out"
  | "cancelled";
export type AssistantResponseSuppressionReason =
  | "required-delegation"
  | "delegation-first-retry"
  | "explore-synthesis-retry";

/** 宿主可见的子代理活动快照；activityId 只用于更新同一张卡片。 */
export interface SubagentActivityEvent {
  activityId: string;
  task: string;
  status: SubagentActivityStatus;
  agentName?: string;
  mode?: "explore" | "worker";
  completionPolicy?: "required" | "optional" | "detached";
  currentAction?: string;
  summary?: string;
  requestedModelRoute?: string;
  resolvedModelRoute?: string;
  thinkingEffort?: string;
  modelSelectionSource?: "ephemeral" | "profile" | "parent";
}

/** 子代理详情轨迹；traceId 在单个 activity 内稳定，工具完成事件用它更新原条目。 */
export type SubagentTraceEvent =
  | { activityId: string; traceId: string; type: "thinking" }
  | { activityId: string; traceId: string; type: "message"; content: string }
  | {
      activityId: string;
      traceId: string;
      type: "tool.started";
      name: string;
      args: string;
    }
  | {
      activityId: string;
      traceId: string;
      type: "tool.completed";
      result: string;
      isError: boolean;
      truncated?: boolean;
    };

/** Agent 引擎向外界输出信息的规范 */
export interface Reporter {
  /** 当 provider 输出原生 thinking/reasoning 时调用 */
  onThinking(): void;
  /** 当模型决定调用工具时调用 */
  /**
   * providerCallId 是 provider 响应内的关联键，跨轮可能重复。
   * 为兼容旧 Reporter 调用暂时可选；新执行层应始终传入 provider ToolCall.id。
   */
  onToolCall(toolName: string, args: string, providerCallId?: string): void;
  /** 当工具在底层执行完毕并返回结果时调用 */
  /** providerCallId 应与 onToolCall 传入的 ID 相同。 */
  onToolResult(toolName: string, result: string, isError: boolean, providerCallId?: string): void;
  /** 工具执行期间的增量输出；当前主要由前台 Bash 提供。 */
  onToolOutput?(
    toolName: string,
    stream: "stdout" | "stderr",
    chunk: string,
    providerCallId?: string,
  ): void;
  /** 子代理活动的可替换快照，用于宿主展示并行 worker 进度。 */
  onSubagentActivity?(activity: SubagentActivityEvent): void;
  /** 对应结果已进入当前或下一次主 Agent 模型边界，可在主正文完成后归档。 */
  onSubagentActivitiesClaimed?(activityIds: readonly string[]): void;
  /** 子代理的独立详情时间线，不进入主对话 transcript。 */
  onSubagentTrace?(event: SubagentTraceEvent): void;
  /** 子代理 Provider 创建完成后的可信路由快照。 */
  onSubagentModelResolved?(model: {
    requestedModelRoute?: string;
    resolvedModelRoute: string;
    thinkingEffort?: string;
    source: "ephemeral" | "profile" | "parent";
  }): void;
  /** 当模型宣告任务完成,向用户输出最终纯文本回答时调用 */
  onMessage(content: string): void;
  /** 引擎启动时调用 */
  onStart(workDir: string): void;
  /** 每个 Turn 开始时调用 */
  onTurnStart(turn: number): void;
  /** 任务完成退出循环时调用 */
  onFinish(): void;
  /** 宿主主动中止当前运行，用于立即收口临时流式 UI。 */
  onInterrupted?(): void;
  /** 流式输出:模型每生成一段文本就调用(仅 generateStream 时触发) */
  onTextDelta?(delta: string): void;
  /** 控制流否决本轮模型正文时，撤销宿主已投影的临时流。 */
  onAssistantResponseSuppressed?(reason: AssistantResponseSuppressionReason): void;
}

/** 默认终端 Reporter:把所有事件打印到控制台 */
export class TerminalReporter implements Reporter {
  // spinner:模型思考时显示动画,给用户"还在转"的反馈。
  private spinnerTimer?: NodeJS.Timeout;
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

  onToolCall(toolName: string, args: string): void {
    this.stopSpinner();
    console.log(`    -> 🛠️ 执行工具: ${toolName}, 参数: ${args}`);
  }

  onToolResult(toolName: string, result: string, isError: boolean): void {
    this.stopSpinner();
    if (isError) {
      console.log(pc.red(`    -> ❌ 工具执行报错: ${result.slice(0, 200)}`));
      return;
    }
    // 摘要:前 3 行(每行截断 100 字符),让用户知道工具读了啥。
    const allLines = result.split("\n");
    const lines = allLines.slice(0, 3).map((l) => l.slice(0, 100));
    const summary = lines.join("\n    | ");
    const more = allLines.length > 3 ? `\n    | ... (共 ${allLines.length} 行)` : "";
    console.log(pc.green(`    -> ✅ ${toolName}`) + ` (返回 ${result.length} 字节)`);
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

  onTextDelta(delta: string): void {
    this.stopSpinner();
    process.stdout.write(delta);
  }

  /** 启动 spinner:每 80ms 刷一帧,思考时给视觉反馈。 */
  private startSpinner(): void {
    if (this.spinnerTimer) return; // 已在转就不重复启动
    this.spinnerIdx = 0;
    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerIdx % this.spinnerFrames.length]!;
      process.stdout.write(`\r${pc.cyan(frame)} 思考中...`);
      this.spinnerIdx++;
    }, 80);
  }

  /** 停止 spinner:清掉定时器 + 擦除当前行的动画残留。 */
  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      process.stdout.write("\r\x1b[K"); // \r 回行首,\x1b[K 清整行
    }
  }
}

/**
 * diff 文本按行着色:+绿 -红 @@青 其他 dim。
 * 导出函数,供 run-agent.ts 的 terminalNotifier 复用(本 worktree 暂不调用,留给合并后)。
 */
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

/** 静默 Reporter:不输出任何内容 (用于测试或后台静默运行) */
export class SilentReporter implements Reporter {
  onStart(): void {}
  onTurnStart(): void {}
  onThinking(): void {}
  onToolCall(): void {}
  onToolResult(): void {}
  onMessage(): void {}
  onFinish(): void {}
}
