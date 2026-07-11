import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { buildMinimalChildProcessEnv } from "../os/child-process-env.js";

/** 每个宿主任务运行时使用一个未创建、不可预测的 hooks 目录。 */
export function createDisabledHooksPath(): string {
  return join(tmpdir(), `pico-disabled-git-hooks-${randomUUID()}`);
}

/**
 * 命令行 -c 的优先级高于仓库与用户配置，因此要在注入 executor
 * 之外统一包装，避免测试/宿主自定义 executor 意外绕过安全边界。
 */
export function hardenGitArgs(args: readonly string[], disabledHooksPath: string): string[] {
  return [
    "-c",
    `core.hooksPath=${disabledHooksPath}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "merge.verifySignatures=false",
    "-c",
    "maintenance.auto=false",
    "-c",
    "maintenance.autoDetach=false",
    "-c",
    "gc.auto=0",
    "-c",
    "credential.helper=",
    ...args,
  ];
}

/** 宿主自动 Git 不继承 API key、SSH agent 或外部注入的 GIT_* 环境。 */
export function buildSafeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = buildMinimalChildProcessEnv({
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  });
  const safePath = environment.PATH?.split(delimiter)
    .filter((entry) => entry.length > 0 && isAbsolute(entry))
    .join(delimiter);
  if (safePath) environment.PATH = safePath;
  else delete environment.PATH;
  return environment;
}

export const UNSAFE_GIT_DRIVER_CONFIG_PATTERN = "^merge\\..*\\.driver$";
export const GIT_FILTER_DRIVER_CONFIG_PATTERN = "^filter\\..*\\.(clean|smudge|process|required)$";

const SAFE_FILTER_DRIVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 将 git config --null --name-only 的 filter 键转为命令级禁用参数。 */
export function disabledGitFilterArgs(configKeys: string): string[] {
  if (configKeys.includes("\ufffd")) {
    throw new Error("Git filter 配置名包含无法安全解码的字节，拒绝自动操作。");
  }

  const driverNames = new Set<string>();
  for (const key of configKeys.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key);
    const driverName = match?.[1];
    if (!driverName || !SAFE_FILTER_DRIVER_NAME_RE.test(driverName)) {
      throw new Error(`Git filter 配置名无法安全重建: ${key}`);
    }
    driverNames.add(driverName);
  }

  return [...driverNames].flatMap((driverName) => [
    "-c",
    `filter.${driverName}.clean=`,
    "-c",
    `filter.${driverName}.smudge=`,
    "-c",
    `filter.${driverName}.process=`,
    "-c",
    `filter.${driverName}.required=false`,
  ]);
}
