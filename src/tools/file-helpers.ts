// 跨工具共享的文件辅助函数与常量。
//
// 这些函数被 read_file / write_file / edit_file 共用,因此独立成模块,
// 避免任一单工具文件成为另一个的依赖来源。
// safeResolve 是纯外部消费(loop.ts / approval/diff.ts)的路径安全检查,
// 与文件内工具类无耦合,也归此模块,经 registry-impl 门面 re-export。

import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolFileSideEffects } from "./registry.js";
import { WorkspaceRoots } from "./workspace-roots.js";

/** O_NOFOLLOW:打开时不跟随符号链接(防穿越)。平台不支持时为 0。 */
export const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;
/** O_NONBLOCK:非阻塞打开,防 FIFO 等特殊文件卡住进程。平台不支持时为 0。 */
export const NON_BLOCKING_FLAG = constants.O_NONBLOCK ?? 0;

/**
 * read_file / edit_file 共用的文件大小硬上限。超过即拒绝读取。
 * edit_file 复用此值做文件快照的有界读取。
 */
export const READ_FILE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 路径安全检查:确保路径在 workDir 之内,防路径穿越。
 * 返回规范化的绝对路径;越界则抛错。
 */
export function safeResolve(workDir: string, path: string): string {
  const base = resolve(workDir);
  const fullPath = isAbsolute(path) ? resolve(path) : resolve(base, path);
  const rel = relative(base, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界: '${path}' 不在工作区 ${base} 之内`);
  }
  return fullPath;
}

/** 把 string | WorkspaceRoots 入参统一成 WorkspaceRoots。Read/Write/Edit 构造时共用。 */
export function workspaceRootsFrom(input: string | WorkspaceRoots): WorkspaceRoots {
  return typeof input === "string" ? WorkspaceRoots.createSync(input) : input;
}

/**
 * 写入前重新解析目标路径,确认与初始解析结果一致。
 * 防止父目录在 mkdir / 原子写中间窗口被替换为越界符号链接。
 */
export function assertSameResolvedTarget(
  roots: WorkspaceRoots,
  requestedPath: string,
  expectedPath: string,
): void {
  let currentPath: string;
  try {
    currentPath = roots.resolveUnchecked(requestedPath);
  } catch (error) {
    throw new Error(`写入前无法重新验证目标路径: ${requestedPath}`, { cause: error });
  }
  if (currentPath !== expectedPath) {
    throw new Error(`写入过程中目标路径已改变: ${requestedPath}`);
  }
}

/** 从工具参数解析出精确路径副作用声明(写工具用)。 */
export function exactPathSideEffects(args: string): ToolFileSideEffects {
  try {
    const { path } = JSON.parse(args) as { path?: unknown };
    return {
      kind: "exact",
      paths: typeof path === "string" && path.length > 0 ? [path] : [],
    };
  } catch {
    return { kind: "exact", paths: [] };
  }
}
