import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PicoWorkspacePaths } from "../paths/pico-paths.js";

/** Session 初始化与 fork 发布必须竞争同一份 durable 目标所有权。 */
export function sessionOwnerLeaseDirectory(
  workspace: Pick<PicoWorkspacePaths, "id" | "root">,
  sessionId: string,
): string {
  const scope = createHash("sha256").update(`${workspace.id}\0${sessionId}`).digest("hex");
  return join(workspace.root, "session-owners", scope);
}
