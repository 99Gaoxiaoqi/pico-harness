// TUI 预加载脚本:在 logger 初始化前静默非交互日志。
// 用法: tsx --env-file=.env --import ./src/tui/preload-env.ts src/cli/main.ts

// Ink 依赖自己的 stdout 写入记录来原位擦除上一帧。Pino transport
// 直接写 stderr(fd 2),不经过 Ink 的 console patch；即使只是一条 warn,
// 也会移动同一 PTY 的光标并让后续全屏帧重复。TUI 是独占屏幕入口,
// 因此始终以 UI reporter 呈现用户可见异常,并在进程级关闭 Pino 终端输出。
// 必须覆盖显式 LOG_LEVEL：否则 .env 中的 debug/info 会重新打开旁路写入。
process.env.LOG_LEVEL = "silent";
