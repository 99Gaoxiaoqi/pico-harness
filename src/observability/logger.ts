// 统一日志器:引擎内部日志走 pino 结构化输出,与面向用户的 console 分离。
//
// 设计原则:
// - 引擎内部日志(loop/registry/approval/compactor/reminder 等核心逻辑)走 pino,
//   可通过 LOG_LEVEL 环境变量控制级别,生产环境关闭 debug 减少噪音
// - 面向用户输出的文件(reporter/cli/feishu/tracer)保留 console,
//   确保用户始终能看到关键信息
//
// pino 是 Node.js 最快 JSON 日志库。transport 使用 pino-pretty 做彩色格式化输出;
// 若 transport 加载失败(如测试环境 worker thread 限制),自动降级为 plain pino。
//
// 重要:pino transport 模式下 logger.level 动态修改对 transport 不生效
// (transport 在 worker thread 里)。TUI 启动前可通过 LOG_LEVEL 环境变量压低级别。

import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: undefined, // 不附加 pid/hostname(教学项目精简输出)
  ...(process.env.NODE_ENV !== "test"
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
            destination: 2, // stderr
          },
        },
      }
    : {}),
});
