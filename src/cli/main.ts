// pico 的唯一外壳入口:TUI。
// 网络服务、机器人、ACP 和 one-shot CLI 都已移除,避免多入口共享 session 造成状态串扰。

import { parseArgs } from "node:util";
import { primeTokenizer } from "../context/token-counter.js";
import { FTS5Store } from "../memory/fts5-store.js";
import type { ProviderKind } from "../provider/factory.js";
import { resolveThinkingEffort } from "../provider/thinking.js";
import { startTuiRepl } from "../tui/repl.js";
import { resolveCliStartupSession } from "./session-args.js";

["SIGINT", "SIGTERM", "beforeExit", "exit"].forEach((evt) => {
  process.on(evt, () => FTS5Store.closeAll());
});

async function main(): Promise<void> {
  await primeTokenizer();

  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      thinking: { type: "string", default: "true" },
      dir: { type: "string" },
      model: { type: "string" },
      "mcp-config": { type: "string" },
      session: { type: "string", short: "S" },
      "continue": { type: "boolean", short: "c" },
      resume: { type: "string" },
      "fork": { type: "string" },
      "fork-session": { type: "string" },
    },
  });

  const provider = values.provider as ProviderKind;
  const thinkingEffort = resolveThinkingEffort(values.thinking);
  const { workDir, sessionSelection } = await resolveCliStartupSession(process.argv.slice(2));
  const model = values.model ?? process.env.LLM_MODEL ?? defaultModelForKind(provider);

  await startTuiRepl({
    workDir,
    provider,
    model,
    thinkingEffort,
    sessionSelection,
    ...(values["mcp-config"] ? { mcpConfigPath: values["mcp-config"] } : {}),
  });
}

function defaultModelForKind(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
    case "gemini":
      return "gemini-2.0-flash";
  }
}

main().catch((err) => {
  console.error("TUI 启动失败:", err);
  process.exit(1);
});
