import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

/**
 * Stable physical workspace identity shared by host resolution and SQLite
 * storage checks. A path may not exist yet during fixture/bootstrap setup.
 */
export function canonicalizeWorkspacePath(workDir: string): string {
  const absolute = resolve(workDir);
  let physical = absolute;
  try {
    physical = realpathSync.native(absolute);
  } catch {
    // The normalized absolute path is the stable identity before creation.
  }
  const normalized = normalize(physical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
