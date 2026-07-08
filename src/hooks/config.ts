// Hooks 配置加载器。
//
// 从 <workDir>/.claw/settings.json 的 `hooks` 字段加载用户配置。
// 遵循 PlanStore / TodoStore 的降级约定:任何 IO / 解析失败都不阻断主流程,
// 返回 undefined 即视为"未配置 hooks",registry 不会挂载 HookRunner。
//
// 路径在调用时绑定 workDir,从源头杜绝路径穿越(与 TodoStore 一致)。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../observability/logger.js";
import type { HookEvent, HooksConfig } from "./types.js";

const SETTINGS_FILENAME = "settings.json";

/** 合法的 HookEvent 集合,用于校验畸形配置 */
const VALID_EVENTS: ReadonlySet<string> = new Set<HookEvent>(["PreToolUse", "PostToolUse"]);

/**
 * 从 <workDir>/.claw/settings.json 加载 hooks 配置。
 *
 * 降级约定(任一失败 → 返回 undefined,registry 不挂 HookRunner):
 *   - 文件不存在(ENOENT)→ undefined(静默,常见全新工作区)
 *   - 权限不足等其他 IO 错误 → undefined(记 warn)
 *   - 畸形 JSON → undefined(记 warn)
 *   - 无 `hooks` 字段或结构非法 → undefined
 *
 * @param workDir 工作区根目录
 * @returns 合法配置返回 HooksConfig;否则 undefined
 */
export async function loadHooksConfig(workDir: string): Promise<HooksConfig | undefined> {
  const settingsPath = join(workDir, ".claw", SETTINGS_FILENAME);

  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (err) {
    // ENOENT:全新工作区或未配置,静默返回 undefined
    if (isErrnoException(err, "ENOENT")) {
      return undefined;
    }
    // 其他 IO 错误:记 warn 后返回 undefined,不阻断
    logger.warn({ err, path: settingsPath }, "读取 settings.json 失败,hooks 不启用");
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err, path: settingsPath }, "settings.json 解析失败,hooks 不启用");
    return undefined;
  }

  // 只认顶层对象且含 hooks 字段
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const hooksField = (parsed as { hooks?: unknown }).hooks;
  if (hooksField === undefined || hooksField === null) {
    return undefined;
  }

  return normalizeHooksConfig(hooksField);
}

/**
 * 归一化 hooks 字段:逐事件、逐 matcher 组、逐 handler 校验,丢弃畸形条目。
 * 全部非法或空 → 返回 undefined。
 */
function normalizeHooksConfig(hooksField: unknown): HooksConfig | undefined {
  if (typeof hooksField !== "object" || hooksField === null) {
    return undefined;
  }

  const config: HooksConfig = {};
  let hasAny = false;

  for (const [eventKey, groupsRaw] of Object.entries(hooksField as Record<string, unknown>)) {
    if (!VALID_EVENTS.has(eventKey)) continue;
    const groups = normalizeMatcherGroups(groupsRaw);
    if (groups.length > 0) {
      config[eventKey as HookEvent] = groups;
      hasAny = true;
    }
  }

  return hasAny ? config : undefined;
}

/** 归一化某事件下的 matcher 组数组,丢弃结构非法或 hooks 为空的条目 */
function normalizeMatcherGroups(groupsRaw: unknown) {
  if (!Array.isArray(groupsRaw)) return [];
  const groups = [];
  for (const groupRaw of groupsRaw) {
    if (groupRaw === null || typeof groupRaw !== "object") continue;
    const { matcher, hooks } = groupRaw as { matcher?: unknown; hooks?: unknown };
    const handlers = normalizeHandlers(hooks);
    if (handlers.length === 0) continue;
    groups.push({
      ...(typeof matcher === "string" ? { matcher } : {}),
      hooks: handlers,
    });
  }
  return groups;
}

/** 归一化 hooks 数组,只保留 type:"command" 且 command 非空的处理器 */
function normalizeHandlers(hooks: unknown) {
  if (!Array.isArray(hooks)) return [];
  const handlers = [];
  for (const hookRaw of hooks) {
    if (hookRaw === null || typeof hookRaw !== "object") continue;
    const { type, command, timeout } = hookRaw as {
      type?: unknown;
      command?: unknown;
      timeout?: unknown;
    };
    if (type !== "command") continue;
    if (typeof command !== "string" || command.trim() === "") continue;
    handlers.push({
      type: "command" as const,
      command,
      ...(typeof timeout === "number" && timeout > 0 ? { timeout } : {}),
    });
  }
  return handlers;
}

/** 判断异常是否为指定 code 的 Node ErrnoException */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
