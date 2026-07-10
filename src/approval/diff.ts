// 审批 diff 预览计算(第 1.3 讲:Diff 预览收尾)。
//
// 解决痛点:审批通知此前只有工具名 + 参数,用户看不到具体改了什么。
// 本模块在工具执行"前"(Middleware 拦截时)主动读文件 + 解析工具参数,
// 复用 generateSimpleDiff 计算 before/after diff,供审批卡片展示。
//
// 关键约束:
// - 审批流程绝不能因为 diff 计算失败而中断。任何异常都吞掉返回 undefined。
// - 只对产生文件变更的工具(edit_file/write_file/bash 重定向)计算 diff。
// - diff 复用 generateSimpleDiff 的内置截断(DIFF_MAX_LINES=30),此处不重复截断。

import { readFile } from "node:fs/promises";
import { generateSimpleDiff, safeResolve } from "../tools/registry-impl.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";

/**
 * 在工具执行前计算审批 diff 预览。
 *
 * 解析工具参数,按工具类型生成 before/after:
 * - edit_file {path, old_text, new_text}:old/new 直接取参数,文件读不到也不影响。
 * - write_file {path, content}:old 读 path 原内容(不存在则空),new 取 content。
 * - bash:解析 `>` / `>>` 重定向目标文件读 old;new 用重定向前的命令文本作近似。
 *
 * @param toolName 工具名
 * @param args     工具参数(JSON 字符串)
 * @param workDir  工作区根目录,用于拼接相对路径
 * @returns diff 字符串;参数非法 / 工具不产生 diff / 计算出错时返回 undefined
 */
export async function computeApprovalDiff(
  toolName: string,
  args: string,
  workDir: string,
  workspaceRoots?: Pick<WorkspaceRoots, "resolve">,
): Promise<string | undefined> {
  // 任何意外都吞掉:审批流程绝不能因 diff 计算而中断。
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object") {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;

    if (toolName === "edit_file") {
      return await computeEditFileDiff(obj, workDir);
    }
    if (toolName === "write_file") {
      return await computeWriteFileDiff(obj, workDir, workspaceRoots);
    }
    if (toolName === "bash") {
      return await computeBashDiff(obj, workDir);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 安全读取文件内容:失败/不存在返回空串(审批只关心相对差异)。 */
async function readFileOrEmpty(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return "";
  }
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** edit_file:old/new 直接取参数,文件读不到也不影响 diff(参数已含原文)。 */
async function computeEditFileDiff(
  obj: Record<string, unknown>,
  workDir: string,
): Promise<string | undefined> {
  const path = obj["path"];
  const oldText = obj["old_text"];
  const newText = obj["new_text"];
  if (!isString(oldText) || !isString(newText)) {
    return undefined;
  }
  // path 缺失也能算 diff(纯参数对比);读到校验失败也不阻断。
  void workDir;
  void path;
  return generateSimpleDiff(oldText, newText);
}

/** write_file:old 读原文件(不存在则空),new 取 content。 */
async function computeWriteFileDiff(
  obj: Record<string, unknown>,
  workDir: string,
  workspaceRoots?: Pick<WorkspaceRoots, "resolve">,
): Promise<string | undefined> {
  const path = obj["path"];
  const content = obj["content"];
  if (!isString(path) || !isString(content)) {
    return undefined;
  }
  const absolutePath = workspaceRoots?.resolve(path) ?? safeResolve(workDir, path);
  const oldText = await readFileOrEmpty(absolutePath);
  return generateSimpleDiff(oldText, content);
}

/**
 * bash:解析 `>` / `>>` 重定向目标文件。
 * - 识别最后一个重定向目标(命令 `a > b > c` 取最后写入的 c),读为 old。
 * - new 用重定向前的命令文本作近似(无法预执行,展示写入意图即可)。
 * - 无重定向或无法解析 → undefined。
 */
async function computeBashDiff(
  obj: Record<string, unknown>,
  workDir: string,
): Promise<string | undefined> {
  const command = obj["command"];
  if (!isString(command)) {
    return undefined;
  }
  // 匹配 `>` 或 `>>` 后跟文件路径(允许前后空格),取重定向目标。
  // 形如:echo x > file.txt / echo x >> file.txt / cat a > b
  const match = command.match(/(?:>>|>)\s*([^\s|;&]+)\s*$/);
  if (!match) {
    return undefined;
  }
  const target = match[1];
  if (!target) {
    return undefined;
  }
  // 重定向前的命令文本作为 new 近似(剥掉重定向部分)。
  const sourceCmd = command.slice(0, match.index).trim();
  // old 读目标文件;new 用源命令文本(无源命令则空串,纯 truncating 重定向)。
  const oldText = await readFileOrEmpty(safeResolve(workDir, target));
  return generateSimpleDiff(oldText, sourceCmd);
}
