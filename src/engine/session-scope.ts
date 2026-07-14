import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** 进程内 session 状态的工作区边界：真实 cwd + 显式 sessionId。 */
export function sessionScopeKey(sessionId: string, cwd: string): string {
  return JSON.stringify([canonicalSessionCwd(cwd), sessionId]);
}

export function canonicalSessionCwd(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    // 嵌入方可能在工作区创建前准备 session 状态。
    return absolute;
  }
}
