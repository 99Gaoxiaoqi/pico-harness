import { resolve } from "node:path";

/**
 * Workspace identity as the host compares it: Windows file systems are
 * case-insensitive, so a realpath and its lowercased storage identity denote
 * the same workspace. POSIX paths stay case-sensitive.
 */
export function sameWorkspacePath(left: string, right: string): boolean {
  const identity = (value: string) => {
    const absolute = resolve(value).normalize("NFC");
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return identity(left) === identity(right);
}
