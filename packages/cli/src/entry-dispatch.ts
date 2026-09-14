import { parseArgs } from "node:util";
import { type CliStartupSession, type ResolveCliStartupSessionOptions } from "./session-args.js";

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
  "--local",
]);

const HELP_TEXT = `Usage: pico [options]

Start the interactive Pico TUI in the current directory.

Options:
  --thinking <off|low|medium|high>   Override the model's default reasoning level
  --dir <path>                       Workspace directory (default: current directory)
  --model <provider/model|name>      Configured model route or unique model name
  -S, --resume <id>                  Resume a session by id
  -c, --continue                     Continue the latest session in this project
      --graph                        Start with persistent Agent Graph scheduling enabled
      --swarm                        Start with autonomous Swarm orchestration (exclusive with --graph)
  --fork <id>                        Fork a saved session into a new session
      --daemon-stop                  Stop the resident local daemon gracefully
  -h, --help                         Show this help without starting the TUI
  -V, --version                      Show the installed version
`;

export interface CliClientReplOptions {
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly forkFrom?: string;
  readonly graphMode?: boolean;
  readonly swarmMode?: boolean;
}

/** CLI 分派所需的外层进程、Host 与 TUI 装配端口。 */
export interface CliRuntime {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly version: string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
  primeTokenizer(): Promise<void>;
  resolveCliWorkDir(dir: string | undefined): Promise<string>;
  ensureWorkspaceTrusted(workDir: string): Promise<void>;
  resolveCliStartupSession(
    args: readonly string[],
    options?: ResolveCliStartupSessionOptions,
  ): Promise<CliStartupSession>;
  startClientRepl(options: CliClientReplOptions): Promise<void>;
  /** 具体 daemon client 归属 Host/进程装配，CLI 仅分派该命令。 */
  stopLocalDaemon?(): Promise<void>;
}

interface ParsedCliOptions {
  thinkingEffort?: CliThinkingEffort;
  dir?: string;
  model?: string;
  graph: boolean;
  swarm: boolean;
  help: boolean;
  version: boolean;
  daemonStop: boolean;
}

interface ParsedCliValues {
  thinking?: string;
  dir?: string;
  model?: string;
  continue?: boolean;
  graph?: boolean;
  swarm?: boolean;
  resume?: string;
  fork?: string;
  "daemon-stop"?: boolean;
  help?: boolean;
  version?: boolean;
}

type CliThinkingEffort = "off" | "low" | "medium" | "high";

class CliUsageError extends Error {}

/**
 * CLI 启动分派：解析参数、执行信任门，并将会话选择投影为 TUI client 启动选项。
 * 具体进程、Host 与 TUI 实现在调用者通过 CliRuntime 注入，保持本包不反向依赖 UI。
 */
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
      if (!runtime.stopLocalDaemon) {
        throw new Error("当前 CLI 宿主未配置 Runtime daemon 关停能力");
      }
      await runtime.stopLocalDaemon();
      return 0;
    }

    const workDir = await runtime.resolveCliWorkDir(options.dir);
    await runtime.ensureWorkspaceTrusted(workDir);
    await runtime.primeTokenizer();
    const { sessionSelection } = await runtime.resolveCliStartupSession(args, {
      trustedWorkDir: workDir,
    });

    const clientSessionId =
      sessionSelection.mode === "resume" || sessionSelection.mode === "continue"
        ? sessionSelection.sessionId
        : undefined;
    const forkFrom =
      sessionSelection.mode === "fork" ? sessionSelection.sourceSessionId : undefined;
    await runtime.startClientRepl({
      workDir,
      ...(clientSessionId ? { sessionId: clientSessionId } : {}),
      ...(forkFrom ? { forkFrom } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      ...(options.graph ? { graphMode: true } : {}),
      ...(options.swarm ? { swarmMode: true } : {}),
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
        thinking: { type: "string" },
        dir: { type: "string" },
        model: { type: "string" },
        continue: { type: "boolean", short: "c" },
        graph: { type: "boolean" },
        swarm: { type: "boolean" },
        resume: { type: "string", short: "S" },
        fork: { type: "string" },
        "daemon-stop": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
    values = parsed.values as ParsedCliValues;
  } catch (error) {
    throw normalizeParseArgsError(error);
  }

  if (values.graph && values.swarm) {
    throw new CliUsageError("--graph 与 --swarm 不能同时使用，请选择一种编排模式。");
  }

  const thinkingEffort =
    values.thinking === undefined ? undefined : parseCliThinkingEffort(values.thinking);

  return {
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(typeof values.dir === "string" ? { dir: values.dir } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    graph: values.graph === true,
    swarm: values.swarm === true,
    help: values.help === true,
    version: values.version === true,
    daemonStop: values["daemon-stop"] === true,
  };
}

function parseCliThinkingEffort(raw: string): CliThinkingEffort {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
  ) {
    return normalized;
  }
  throw new CliUsageError(`--thinking 只接受 off、low、medium 或 high；收到 ${raw || "(空值)"}`);
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
