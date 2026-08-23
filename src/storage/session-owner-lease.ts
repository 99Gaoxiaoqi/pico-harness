import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PicoWorkspacePaths } from "../paths/pico-paths.js";
import { retireOwnerLeaseForTerminatedProcess } from "./owner-lease.js";

const SESSION_OWNER_DIRECTORY_NAME = /^[a-f0-9]{64}$/u;

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

/**
 * Retires only Session leases inside Pico's device-local workspace roots that
 * still name the exact terminated daemon process on this host. Candidate and
 * tombstone directories, symlinks, malformed records, foreign hosts and other
 * PIDs are deliberately left untouched.
 */
export async function retireSessionOwnerLeasesForTerminatedProcess(options: {
  picoHome: string;
  expectedPid: number;
}): Promise<number> {
  const workspaceEntries = await readDirectories(join(options.picoHome, "workspaces"));
  let retired = 0;
  for (const workspaceEntry of workspaceEntries) {
    const ownerRoot = join(options.picoHome, "workspaces", workspaceEntry, "session-owners");
    const ownerEntries = await readDirectories(ownerRoot);
    for (const ownerEntry of ownerEntries) {
      if (!SESSION_OWNER_DIRECTORY_NAME.test(ownerEntry)) continue;
      if (
        await retireOwnerLeaseForTerminatedProcess({
          leaseDirectory: join(ownerRoot, ownerEntry),
          expectedPid: options.expectedPid,
          expectedHostname: hostname(),
        })
      ) {
        retired += 1;
      }
    }
  }
  return retired;
}

async function readDirectories(path: string): Promise<string[]> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [];
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
