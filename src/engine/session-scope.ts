import { resolvePicoPaths } from "../paths/pico-paths.js";

/** 与 SessionManager 一致的进程内边界：Pico workspace root + 显式 sessionId。 */
export function sessionScopeKey(sessionId: string, cwd: string, picoHome?: string): string {
  const workspaceRoot = resolvePicoPaths(cwd, { picoHome }).workspace.root;
  return JSON.stringify([workspaceRoot, sessionId]);
}
