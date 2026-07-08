// TUI 预加载脚本:在所有模块 import 之前设置环境变量。
// 用法: npx tsx --import ./src/tui/preload-env.ts --env-file=.env src/cli/main.ts --tui
//
// 为什么需要预加载:ES module 的 import 是静态提升的,main.ts 里即使把
// process.env.LOG_LEVEL = "warn" 写在第一行,也来不及——logger.ts 已被
// import 链初始化了(transport 在 worker thread 里,主线程改 level 无效)。
// --import 预加载在所有用户模块 import 之前执行,确保 LOG_LEVEL 生效。
//
// pino transport 读的是启动时的 LOG_LEVEL,之后不再读,故这样最可靠。

// 检测是否 TUI 模式(命令行参数含 --tui)
if (process.argv.includes("--tui") && !process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = "warn";
}
