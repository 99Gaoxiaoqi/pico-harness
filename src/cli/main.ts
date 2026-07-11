#!/usr/bin/env node

// pico 的唯一外壳入口:TUI。
// 网络服务、机器人、ACP 和 one-shot CLI 都已移除,避免多入口共享 session 造成状态串扰。

// 发布后的 pico 直接执行 dist/cli/main.js,不会经过 npm dev 的 --import。
// 必须在其他依赖图执行前预加载,避免 Pino 先以 stderr transport 初始化。
import "../tui/preload-env.js";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { primeTokenizer } from "../context/token-counter.js";
import { FTS5Store } from "../memory/fts5-store.js";
import type { ProviderKind } from "../provider/factory.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import { ensureWorkspaceTrusted } from "../security/workspace-trust.js";
import { startTuiRepl, type ReplOptions } from "../tui/repl.js";
import {
  resolveCliStartupSession,
  resolveCliWorkDir,
  type CliStartupSession,
  type ResolveCliStartupSessionOptions,
} from "./session-args.js";
import { createTerminalWorkspaceTrustPrompt } from "./workspace-trust-prompt.js";

const RETIRED_OPTIONS = new Set([
  "--tui",
  "--prompt",
  "--serve",
  "--port",
  "--acp",
  "--feishu",
  "--mode",
  "--plan",
  "--trace",
  "--image",
  "--list-snapshots",
  "--rewind",
  "--rewind-mode",
  "--rollback",
  "--undo",
  "--steer",
]);

const HELP_TEXT = `Usage: pico [options]

Start the interactive Pico TUI in the current directory.

Options:
  --provider <openai|claude|gemini>  Provider protocol (default: openai)
  --thinking <off|low|medium|high>   Override the model's default reasoning level
  --dir <path>                       Workspace directory (default: current directory)
  --model <provider/model|name>      Model route or legacy model name
  --mcp-config <path>                MCP server configuration file
  --add-dir <path>                   Add an authorized workspace directory (repeatable)
  -S, --session <id>                 Resume a session by id
  -c, --continue                     Continue the latest session in this project
  --resume <id>                      Resume a session by id
  --fork <id>                        Fork a saved session into a new session
  --fork-session <id>                Alias for --fork
  -h, --help                         Show this help without starting the TUI
  -V, --version                      Show the installed version
`;

export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  version: string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  primeTokenizer(): Promise<void>;
  resolveCliWorkDir(dir: string | undefined): Promise<string>;
  ensureWorkspaceTrusted(workDir: string): Promise<void>;
  resolveCliStartupSession(
    args: readonly string[],
    options?: ResolveCliStartupSessionOptions,
  ): Promise<CliStartupSession>;
  startTuiRepl(options: ReplOptions): Promise<void>;
}

interface ParsedCliOptions {
  provider: ProviderKind;
  thinkingEffort?: ThinkingEffort;
  dir?: string;
  model?: string;
  mcpConfigPath?: string;
  addDirs?: string[];
  help: boolean;
  version: boolean;
}

interface ParsedCliValues {
  provider?: string;
  thinking?: string;
  dir?: string;
  model?: string;
  "mcp-config"?: string;
  "add-dir"?: string[];
  session?: string;
  continue?: boolean;
  resume?: string;
  fork?: string;
  "fork-session"?: string;
  help?: boolean;
  version?: boolean;
}

class CliUsageError extends Error {}

export async function runCli(args: readonly string[], runtime: CliRuntime): Promise<number> {
  try {
    const options = parseCliOptions(args);
    if (options.help) {
      runtime.writeStdout(HELP_TEXT);
      return 0;
    }
    if (options.version) {
      runtime.writeStdout(`${runtime.version}\n`);
      return 0;
    }

    // 只先解析真实路径；信任门通过前不读项目 session / config / Skills，
    // 也不启动 Provider、LSP、MCP 或 Hook。
    const workDir = await runtime.resolveCliWorkDir(options.dir);
    await runtime.ensureWorkspaceTrusted(workDir);
    await runtime.primeTokenizer();
    const { sessionSelection } = await runtime.resolveCliStartupSession(args, {
      trustedWorkDir: workDir,
    });
    const model = options.model ?? runtime.env.LLM_MODEL ?? defaultModelForKind(options.provider);

    await runtime.startTuiRepl({
      workDir,
      provider: options.provider,
      model,
      modelExplicit: options.model !== undefined,
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      sessionSelection,
      ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
      ...(options.addDirs ? { addDirs: options.addDirs } : {}),
    });
    return 0;
  } catch (error) {
    runtime.writeStderr(`${formatCliError(error)}\n`);
    return 1;
  }
}

function parseCliOptions(args: readonly string[]): ParsedCliOptions {
  const retired = findRetiredOption(args);
  if (retired) {
    throw new CliUsageError(
      `启动参数 ${retired} 已退役。Pico 现在只提供交互式 TUI 入口；直接运行 pico，或用 pico --help 查看仍支持的参数。`,
    );
  }

  let values: ParsedCliValues;
  try {
    const parsed = parseArgs({
      args: [...args],
      options: {
        provider: { type: "string", default: "openai" },
        thinking: { type: "string" },
        dir: { type: "string" },
        model: { type: "string" },
        "mcp-config": { type: "string" },
        "add-dir": { type: "string", multiple: true },
        session: { type: "string", short: "S" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "string" },
        fork: { type: "string" },
        "fork-session": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
    values = parsed.values as ParsedCliValues;
  } catch (error) {
    throw normalizeParseArgsError(error);
  }

  const provider = values.provider;
  if (!isProviderKind(provider)) {
    throw new CliUsageError(
      `不支持的 provider: ${String(provider)}。可选值: openai / claude / gemini。`,
    );
  }

  const thinkingEffort =
    values.thinking === undefined ? undefined : resolveThinkingEffort(values.thinking);

  return {
    provider,
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(typeof values.dir === "string" ? { dir: values.dir } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values["mcp-config"] === "string" ? { mcpConfigPath: values["mcp-config"] } : {}),
    ...(Array.isArray(values["add-dir"]) ? { addDirs: values["add-dir"] } : {}),
    help: values.help === true,
    version: values.version === true,
  };
}

function findRetiredOption(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const option = arg.split("=", 1)[0];
    if (option && RETIRED_OPTIONS.has(option)) return option;
  }
  return undefined;
}

function normalizeParseArgsError(error: unknown): CliUsageError {
  if (!(error instanceof Error)) return new CliUsageError(String(error));
  const code = "code" in error ? String(error.code) : "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const option = error.message.match(/'([^']+)'/u)?.[1] ?? "(无法识别)";
    return new CliUsageError(`未知启动参数: ${option}。请运行 pico --help 查看可用参数。`);
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
    const positional = error.message.match(/'([^']+)'/u)?.[1] ?? "(无法识别)";
    return new CliUsageError(
      `不支持位置参数: ${positional}。Pico 现在只提供交互式 TUI 入口；请运行 pico --help。`,
    );
  }
  return new CliUsageError(`${error.message}。请运行 pico --help 查看可用参数。`);
}

function formatCliError(error: unknown): string {
  if (error instanceof CliUsageError) return error.message;
  return `TUI 启动失败: ${error instanceof Error ? error.message : String(error)}`;
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "openai" || value === "claude" || value === "gemini";
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

async function loadPackageVersion(): Promise<string> {
  const packagePath = new URL("../../package.json", import.meta.url);
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`package.json 缺少有效 version: ${fileURLToPath(packagePath)}`);
  }
  return parsed.version;
}

async function isEntrypoint(): Promise<boolean> {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    const [modulePath, launchedPath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(argvPath),
    ]);
    return modulePath === launchedPath;
  } catch {
    return false;
  }
}

async function executeEntrypoint(): Promise<void> {
  ["SIGINT", "SIGTERM", "beforeExit", "exit"].forEach((event) => {
    process.on(event, () => FTS5Store.closeAll());
  });
  const runtime: CliRuntime = {
    env: process.env,
    version: await loadPackageVersion(),
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
    primeTokenizer,
    resolveCliWorkDir,
    ensureWorkspaceTrusted: async (workDir) => {
      const prompt =
        process.stdin.isTTY && process.stdout.isTTY
          ? createTerminalWorkspaceTrustPrompt({ input: process.stdin, output: process.stdout })
          : undefined;
      await ensureWorkspaceTrusted(workDir, { ...(prompt ? { prompt } : {}) });
    },
    resolveCliStartupSession,
    startTuiRepl,
  };
  process.exitCode = await runCli(process.argv.slice(2), runtime);
}

if (await isEntrypoint()) {
  await executeEntrypoint();
}
