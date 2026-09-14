import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { buildMinimalChildProcessEnv } from "./minimal-child-process-env.js";

/** Each host task runtime uses an uncreated, unpredictable hooks directory. */
export function createDisabledHooksPath(): string {
  return join(tmpdir(), `pico-disabled-git-hooks-${randomUUID()}`);
}

/** Inject command-line overrides that cannot be bypassed by repository/user configuration. */
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

/** Automatic Git never inherits API keys, an SSH agent, or externally injected GIT_* variables. */
export function buildSafeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = buildMinimalChildProcessEnv({ GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" });
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

/** Convert `git config --null --name-only` filter keys to command-level disable overrides. */
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
