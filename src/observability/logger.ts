// 统一日志器:引擎内部日志走 pino 结构化输出,与面向用户的 console 分离。
//
// 设计原则:
// - 引擎内部日志(loop/registry/approval/compactor/reminder 等核心逻辑)走 pino,
//   可通过 LOG_LEVEL 环境变量控制级别,生产环境关闭 debug 减少噪音
// - 面向用户输出的文件(reporter/cli/feishu/tracer)保留 console,
//   确保用户始终能看到关键信息
//
// pino 是 Node.js 最快 JSON 日志库。CLI 开发态使用 pino-pretty 做彩色格式化输出;
// Electron 与测试环境使用 plain pino，避免打包应用依赖开发态 transport。
//
// 重要:pino transport 模式下 logger.level 动态修改对 transport 不生效
// (transport 在 worker thread 里)。TUI 启动前可通过 LOG_LEVEL 环境变量压低级别。

import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const usePrettyTransport = process.env.NODE_ENV !== "test" && !process.versions.electron;
const REDACTED = "[REDACTED]";

/**
 * Credentials may enter process-local provider configuration, but must never cross the logging
 * boundary. Keep these paths exact so metadata such as apiKeyEnv remains useful for diagnostics.
 */
const CREDENTIAL_REDACTION_PATHS = [
  "apiKey",
  "config.apiKey",
  "config.providers.*.apiKey",
  "providers.*.apiKey",
  "data.apiKey",
  "data.config.apiKey",
  "data.config.providers.*.apiKey",
  "data.providers.*.apiKey",
  "req.apiKey",
  "req.body.apiKey",
  "req.body.config.apiKey",
  "req.body.config.providers.*.apiKey",
  "req.body.providers.*.apiKey",
  "req.params.apiKey",
  "res.apiKey",
  "res.body.apiKey",
  "res.body.config.apiKey",
  "res.body.config.providers.*.apiKey",
  "res.body.providers.*.apiKey",
  "error.apiKey",
  "error.data.apiKey",
  "error.data.config.apiKey",
  "error.data.config.providers.*.apiKey",
  "error.data.providers.*.apiKey",
  "err.apiKey",
  "err.data.apiKey",
  "err.data.config.apiKey",
  "err.data.config.providers.*.apiKey",
  "err.data.providers.*.apiKey",
] as const;

export const logger = pino({
  level,
  base: undefined, // 不附加 pid/hostname(教学项目精简输出)
  redact: { paths: [...CREDENTIAL_REDACTION_PATHS], censor: REDACTED },
  ...(usePrettyTransport
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
