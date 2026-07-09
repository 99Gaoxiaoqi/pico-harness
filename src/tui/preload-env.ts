// TUI 预加载脚本:在 logger 初始化前静默非交互日志。
// 用法: tsx --env-file=.env --import ./src/tui/preload-env.ts src/cli/main.ts

if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "warn";
}
