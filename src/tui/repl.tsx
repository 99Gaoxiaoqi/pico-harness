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

import { useState } from "react";
import { render } from "ink";
import { App } from "./app.js";
import { TuiReporter, type TuiEntry } from "./tui-reporter.js";
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
  // 共享状态:TuiReporter 和 App 共用同一个 entries 数组引用
  const entries: TuiEntry[] = [];

  // ink render 需要 setState 驱动重渲染,用一个包装组件管理 entries/running 状态
  let setEntries: (e: TuiEntry[]) => void = () => {};
  let setRunning: (r: boolean) => void = () => {};

  // TuiReporter:onUpdate 回调把新 entries 推给 ink 的 setState
  const reporter = new TuiReporter((next) => setEntries(next), entries);

  // 包装组件:管理 entries/running 状态,把 setter 暴露给外部
  function ReplApp() {
    const [stateEntries, setStateEntries] = useState<TuiEntry[]>([]);
    const [running, setStateRunning] = useState(false);
    setEntries = setStateEntries;
    setRunning = setStateRunning;

    const handleSubmit = async (text: string): Promise<void> => {
      reporter.pushUserMessage(text);
      setRunning(true);
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
        setRunning(false);
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

  render(<ReplApp />);
}
