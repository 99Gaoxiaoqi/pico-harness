// TUI REPL 启动器:装配 ink render + TuiReporter,循环接收用户输入调 engine。
//
// 设计权衡(极简优先):
// runAgentFromCli 的装配链很重(凭证轮换/provider/registry/MCP/审批)。
// 不重新装配,而是每轮用户输入调一次 runAgentFromCli,共享同一个 TuiReporter。
// session 通过 consoleSessionId(workDir) 固定 ID 复用(run-agent.ts:146-149)。
// 这样零改动 run-agent.ts,MVP 最小侵入。
//
// 代价:每轮重建 engine 对象(轻量,不重连 MCP——MCP 配置只在首轮传)。
// 对 MVP 可接受;后续若要复用 engine 实例,再抽取 buildEngine()。
//
// 并发防护(对标 Claude Code):用 QueryGuard 三态状态机 + generation 防陈旧。
// 用户连按 Enter 时,第二个查询让第一个的 finally 块 generation 不匹配,
// 跳过 cleanup,避免竞态。running 由 status !== "idle" 派生(同步,无 React batch 延迟)。

import { useRef, useState, useSyncExternalStore } from "react";
import { render } from "ink";
import { App } from "./app.js";
import { TuiReporter, type TuiEntry } from "./tui-reporter.js";
import { QueryGuard } from "./query-guard.js";
import type { RunAgentCliOptions } from "../cli/run-agent.js";
import { runAgentFromCli } from "../cli/run-agent.js";
import type { ProviderKind } from "../provider/factory.js";

export interface ReplOptions {
  /** 工作区 */
  workDir: string;
  /** provider 类型 */
  provider?: ProviderKind;
  /** 模型名(顶栏展示) */
  model: string;
  /** 慢思考 */
  enableThinking?: boolean;
  /** MCP 配置路径(可选,首轮传入) */
  mcpConfigPath?: string;
}

/** 启动 TUI REPL 循环 */
export async function startTuiRepl(opts: ReplOptions): Promise<void> {
  // 日志静默由 preload-env.ts 在模块加载前设 LOG_LEVEL=warn 完成
  // (pino transport 是 worker thread,运行时改 logger.level 无效)。

  // 诊断:hook process.stdout.write,记录 ink 实际输出的 ANSI(看擦除行为)
  if (process.env.TUI_DEBUG) {
    const { appendFileSync } = await import("node:fs");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const origWrite = process.stdout.write.bind(process.stdout) as any;
    let frame = 0;
    const stdoutAny = process.stdout as any;
    stdoutAny._origWrite = origWrite;
    stdoutAny.write = (chunk: unknown, ...args: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : String(chunk);
      if (str.includes("\x1b[") || frame < 5) {
        const visible = str.replace(/\x1b\[/g, "ESC[").replace(/\x1b/g, "ESC").slice(0, 200);
        appendFileSync(".claw/tui-debug.log", `[stdout f${frame}] ${visible}\n`);
      }
      frame++;
      return origWrite(chunk, ...args);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // 共享状态:TuiReporter 和 App 共用同一个 entries 数组引用
  const entries: TuiEntry[] = [];

  // ink render 需要 setState 驱动重渲染,用一个包装组件管理 entries 状态
  let setEntries: (e: TuiEntry[]) => void = () => {};

  // TuiReporter:onUpdate 回调把新 entries 推给 ink 的 setState
  const reporter = new TuiReporter((next) => setEntries(next), entries);

  // 包装组件:管理 entries 状态 + QueryGuard 派生 running,把 setter 暴露给外部
  function ReplApp() {
    const [stateEntries, setStateEntries] = useState<TuiEntry[]>([]);
    setEntries = setStateEntries;

    // QueryGuard:三态状态机(idle/dispatching/running),useSyncExternalStore 订阅。
    // 稳定引用,放在 useRef 里只创建一次。
    const guardRef = useRef<QueryGuard>(null);
    if (guardRef.current === null) guardRef.current = new QueryGuard();
    const guard = guardRef.current;
    const status = useSyncExternalStore(guard.subscribe, guard.getSnapshot);
    const running = status !== "idle"; // 派生:非 idle 即视为运行中

    const handleSubmit = async (text: string): Promise<void> => {
      // 并发防护:已在运行则拒绝新提交。tryStart 返回 generation 号或 null。
      const gen = guard.tryStart();
      if (gen === null) return;

      reporter.pushUserMessage(text);
      try {
        const cliOpts: RunAgentCliOptions = {
          prompt: text,
          provider: opts.provider ?? "openai",
          dir: opts.workDir,
          enableThinking: opts.enableThinking ?? true,
          ...(opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : {}),
        };
        // 复用 session(consoleSessionId 固定),reporter 是 TuiReporter 实例(共享 entries)
        await runAgentFromCli(cliOpts, { reporter });
      } catch (err) {
        // 错误以 assistant 条目形式展示(不入侵 ink 渲染层)
        entries.push({
          kind: "assistant",
          content: `⚠️ 执行出错: ${err instanceof Error ? err.message : String(err)}`,
        });
        setEntries([...entries]);
      } finally {
        // generation 防陈旧:若期间用户发起了新查询(自增 generation),此处 mismatch
        // → end 返回 false,跳过 cleanup,避免把新查询误判为结束。
        guard.end(gen);
        // 兜底:确保本轮 mode 回到 idle(reporter.getMode 供 app.tsx 的 spinner 用)
        // 注:reporter.onFinish 已设 idle;此处仅在出错未触发 onFinish 时补救。
      }
    };

    return (
      <App
        model={opts.model}
        workDir={opts.workDir}
        entries={stateEntries}
        running={running}
        onSubmit={(text) => void handleSubmit(text)}
      />
    );
  }

  // alternateScreen:true 进 alt buffer。alt buffer 下 ink 走 clearTerminal 全量重绘
  // (而非 eraseLines 逐行擦除),绕过行数计算 bug(中文字符宽度导致行数不匹配)。
  // patchConsole:false 让 stderr 不被劫持。
  render(<ReplApp />, { alternateScreen: true, patchConsole: false });
}
