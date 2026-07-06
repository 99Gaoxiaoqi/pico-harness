// Reporter 接口:引擎与输入输出 (I/O) 的彻底解耦。
// 对应课程第 09 讲 internal/engine/reporter.go。
//
// 设计哲学(类比 Linux):内核只负责调度运算,显示交给终端设备。
// 引擎不该关心自己在哪运行,只在生命周期节点向外"广播"事件。
// 注入不同实现即可切换展现层:TerminalReporter(CLI)/ WebReporter(HTTP)等。

/** Agent 引擎向外界输出信息的规范 */
export interface Reporter {
  /** 当模型开始进行慢思考 (Reasoning) 时调用 */
  onThinking(): void;
  /** 当模型决定调用工具时调用 */
  onToolCall(toolName: string, args: string): void;
  /** 当工具在底层执行完毕并返回结果时调用 */
  onToolResult(toolName: string, result: string, isError: boolean): void;
  /** 当模型宣告任务完成,向用户输出最终纯文本回答时调用 */
  onMessage(content: string): void;
  /** 引擎启动时调用 */
  onStart(workDir: string, enableThinking: boolean): void;
  /** 每个 Turn 开始时调用 */
  onTurnStart(turn: number): void;
  /** 任务完成退出循环时调用 */
  onFinish(): void;
  /** 流式输出:模型每生成一段文本就调用(仅 generateStream 时触发) */
  onTextDelta?(delta: string): void;
}

/** 默认终端 Reporter:把所有事件打印到控制台 */
export class TerminalReporter implements Reporter {
  onStart(workDir: string, enableThinking: boolean): void {
    console.log(`[Engine] 引擎启动,锁定工作区: ${workDir}`);
    console.log(`[Engine] 慢思考模式 (Thinking Phase): ${enableThinking}`);
  }

  onTurnStart(turn: number): void {
    console.log(`\n========== [Turn ${turn}] 开始 ==========`);
  }

  onThinking(): void {
    console.log("[Engine][Phase 1] 剥夺工具访问权,强制进入慢思考与规划阶段...");
  }

  onToolCall(toolName: string, args: string): void {
    console.log(`    -> 🛠️ 执行工具: ${toolName}, 参数: ${args}`);
  }

  onToolResult(toolName: string, result: string, isError: boolean): void {
    void toolName;
    if (isError) {
      console.log(`    -> ❌ 工具执行报错: ${result}`);
    } else {
      console.log(`    -> ✅ 工具执行成功 (返回 ${result.length} 字节)`);
    }
  }

  onMessage(content: string): void {
    console.log(`🤖 [对外回复]: ${content}`);
  }

  onFinish(): void {
    console.log("[Engine] 模型未请求调用工具,任务宣告完成。");
  }

  onTextDelta(delta: string): void {
    process.stdout.write(delta);
  }
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
