#!/usr/bin/env node

// pico 的唯一外壳入口:TUI。
// 网络服务、机器人、ACP 和 one-shot CLI 都已移除,避免多入口共享 session 造成状态串扰。

// 发布后的 pico 直接执行 dist/cli/main.js,不会经过 npm dev 的 --import。
// 必须在其他依赖图执行前预加载,避免 Pino 先以 stderr transport 初始化。
import "../tui/preload-env.js";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import { LocalRuntimeClient, RuntimeClientError } from "../daemon/client.js";
import { resolveCanonicalPicoHome } from "../daemon/endpoint.js";
import { sleepForRetry } from "../provider/retry.js";
import { primeTokenizer } from "../context/token-counter.js";
import type { ProviderKind } from "../provider/factory.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import { ensureWorkspaceTrusted } from "../security/workspace-trust.js";
import { startTuiRepl, type ReplOptions } from "../tui/repl.js";
import { startClientRepl, type ClientReplOptions } from "../tui/client-repl.js";
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
  "--steer",
]);

const HELP_TEXT = `Usage: pico [options]

Start the interactive Pico TUI in the current directory.

Options:
  --provider <openai|claude>         Provider protocol (default: openai)
  --thinking <off|low|medium|high>   Override the model's default reasoning level
  --dir <path>                       Workspace directory (default: current directory)
  --model <provider/model|name>      Model route or legacy model name
  --mcp-config <path>                MCP server configuration file
  --add-dir <path>                   Add an authorized workspace directory (repeatable)
  -S, --session <id>                 Resume a session by id
  -c, --continue                     Continue the latest session in this project
      --graph                        Start with Graph Mode enabled (add_work scheduling)
  --resume <id>                      Resume a session by id
  --fork <id>                        Fork a saved session into a new session
  --fork-session <id>                Alias for --fork
      --daemon-stop                  Stop the resident local daemon gracefully
      --client                       Run the TUI as a daemon thin client (3-D tracer)
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
  startClientRepl(options: ClientReplOptions): Promise<void>;
}

interface ParsedCliOptions {
  provider: ProviderKind;
  thinkingEffort?: ThinkingEffort;
  dir?: string;
  model?: string;
  mcpConfigPath?: string;
  addDirs?: string[];
  graph: boolean;
  help: boolean;
  version: boolean;
  daemonStop: boolean;
  client: boolean;
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
  graph?: boolean;
  resume?: string;
  fork?: string;
  "fork-session"?: string;
  "daemon-stop"?: boolean;
  client?: boolean;
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
    if (options.daemonStop) {
      return await stopLocalDaemon(runtime);
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

    // 3-D Phase 2 客户端 tracer：TUI 走 daemon 瘦客户端（connectOrSpawn 拉起/
    // 连上常驻 daemon），本进程零引擎装配。模型路由归 daemon（BYOK 旗标合并是
    // Phase 3）；会话选择 v1 仅支持 -S 显式 sessionId。
    if (options.client) {
      if (sessionSelection && sessionSelection.mode !== "new" && sessionSelection.mode !== "resume") {
        runtime.writeStderr(
          "提示：客户端模式暂只支持新会话与 -S/--resume 显式恢复；--continue/--fork 请用进程内模式（3-D Phase 3 补全）。\n",
        );
      }
      const clientSessionId =
        sessionSelection?.mode === "resume" ? sessionSelection.sessionId : undefined;
      if (options.provider !== "openai" && options.model === undefined) {
        runtime.writeStderr(
          "提示：客户端模式下 --provider 由模型路由隐含决定（裸旗标无 daemon 等价物），请用 --model <provider/model> 指定路由。\n",
        );
      }
      await runtime.startClientRepl({
        workDir,
        ...(clientSessionId ? { sessionId: clientSessionId } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      });
      return 0;
    }

    await runtime.startTuiRepl({
      workDir,
      provider: options.provider,
      model,
      modelExplicit: options.model !== undefined,
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      sessionSelection,
      ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
      ...(options.addDirs ? { addDirs: options.addDirs } : {}),
      ...(options.graph ? { orchestrationMode: "graph" as const } : {}),
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
        graph: { type: "boolean" },
        resume: { type: "string" },
        fork: { type: "string" },
        "fork-session": { type: "string" },
        "daemon-stop": { type: "boolean" },
        client: { type: "boolean" },
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
    throw new CliUsageError(`不支持的 provider: ${String(provider)}。可选值: openai / claude。`);
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
    graph: values.graph === true,
    help: values.help === true,
    version: values.version === true,
    daemonStop: values["daemon-stop"] === true,
    client: values.client === true,
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
  return value === "openai" || value === "claude";
}

function defaultModelForKind(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
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

/**
 * `pico --daemon-stop`：请求常驻 daemon 优雅关停（3-B-4）。先按 registration
 * 探测是否真有 daemon 在跑——没有就报"未在运行"直接返回，绝不借 connectOrSpawn
 * 拉起一个新 daemon 再停掉（那会把"停 daemon"变成"启动一次完整装配"的副作用）。
 * 请求返回后 daemon 仍在收尾（composition.close → 守卫锁释放 → residency 归零），
 * 这里轮询 registration 消失/进程退出作有界确认。
 */
async function stopLocalDaemon(runtime: CliRuntime): Promise<number> {
  const picoHome = resolveCanonicalPicoHome({ env: runtime.env });
  const registration = await readLocalDaemonRegistration(picoHome);
  if (!registration) {
    runtime.writeStdout("本机 Runtime daemon 未在运行。\n");
    return 0;
  }
  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  try {
    await client.shutdownDaemon();
  } catch (error) {
    if (!(error instanceof RuntimeClientError)) throw error;
    // daemon 可能在请求到达前自行退出（如 idle 自退竞态）：按"已停止"处理。
    runtime.writeStdout(`本机 Runtime daemon 已停止。\n`);
    return 0;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const current = await readLocalDaemonRegistration(picoHome);
    if (!current || !(await isProcessAlive(current.pid))) {
      runtime.writeStdout("本机 Runtime daemon 已优雅停止。\n");
      return 0;
    }
    await sleepForRetry(200);
  }
  throw new Error("Runtime daemon 关停超时（15s 内未退出），请检查进程状态");
}

async function readLocalDaemonRegistration(picoHome: string): Promise<{ pid: number } | undefined> {
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    return await readHostRegistration(join(resolveRootControlNamespace(), capability.rootId));
  } catch {
    return undefined;
  }
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    startClientRepl,
  };
  process.exitCode = await runCli(process.argv.slice(2), runtime);
}

if (await isEntrypoint()) {
  await executeEntrypoint();
}
