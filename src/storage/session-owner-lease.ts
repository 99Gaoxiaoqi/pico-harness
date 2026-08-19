import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PicoWorkspacePaths } from "../paths/pico-paths.js";

/**
 * Session 初始化与 fork 发布必须竞争同一份 durable 目标所有权。
 *
 * SQLite 纪元(票 03):lease 目录不得落在 `.storage/` 下——该目录是旧
 * session-centric 纪元的 fail-closed marker,创建即毒化存储根。改挂
 * `<workspaceRoot>/session-owners/`,与 memory/、evidence/ 同级的并存目录。
 */
export function sessionOwnerLeaseDirectory(
  workspace: Pick<PicoWorkspacePaths, "id" | "root">,
  sessionId: string,
): string {
  const scope = createHash("sha256").update(`${workspace.id}\0${sessionId}`).digest("hex");
  return join(workspace.root, "session-owners", scope);
}
