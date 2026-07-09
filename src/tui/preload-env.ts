// TUI 预加载脚本:在所有模块 import 之前设置环境变量。
// 用法: npx tsx --import ./src/tui/preload-env.ts --env-file=.env src/cli/main.ts --tui
//
// 为什么需要预加载:ES module 的 import 是静态提升的,main.ts 里即使把
// process.env.LOG_LEVEL = "warn" 写在第一行,也来不及——logger.ts 已被
// import 链初始化了(transport 在 worker thread 里,主线程改 level 无效)。
// --import 预加载在所有用户模块 import 之前执行,确保 LOG_LEVEL 生效。
//
// pino transport 读的是启动时的 LOG_LEVEL,之后不再读,故这样最可靠。

// 检测是否 TUI 模式:
// - 显式 --tui
// - 或默认交互启动:没有 --prompt / 位置任务 / 其他独立入口
if (shouldSilenceLogsForTui(process.argv) && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "warn";
}

function shouldSilenceLogsForTui(argv: readonly string[]): boolean {
  const userArgs = extractUserArgs(argv);
  if (userArgs.includes("--tui")) return true;

  if (hasAnyFlag(userArgs, ["--serve", "--feishu", "--acp", "--list-snapshots", "--rewind"])) {
    return false;
  }
  if (hasOptionWithValue(userArgs, "--prompt")) return false;
  return !hasPositionalTask(userArgs);
}

function extractUserArgs(argv: readonly string[]): string[] {
  const scriptIndex = argv.findIndex((arg) => arg.endsWith("src/cli/main.ts"));
  return scriptIndex >= 0 ? [...argv.slice(scriptIndex + 1)] : [...argv.slice(2)];
}

function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function hasOptionWithValue(args: readonly string[], option: string): boolean {
  return args.some((arg, index) => arg === option || arg.startsWith(`${option}=`) || args[index - 1] === option);
}

function hasPositionalTask(args: readonly string[]): boolean {
  const optionsWithValues = new Set([
    "--provider",
    "--thinking",
    "--dir",
    "--session",
    "--resume",
    "-r",
    "--fork-session",
    "--prompt",
    "--model",
    "--api-key",
    "--base-url",
    "--port",
    "--mcp-config",
    "--rewind-mode",
    "--steer",
    "--image",
    "--mode",
  ]);

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (optionsWithValues.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return true;
  }

  return false;
}
