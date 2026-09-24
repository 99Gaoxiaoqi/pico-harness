import { randomBytes } from "node:crypto";
import { constants, readFileSync, rmSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "@pico/storage/secure-file";

const FILE_NAME = "desktop-client-capability-token";

/**
 * Local capability secret for the Electron main process and its daemon. It keeps
 * general Runtime RPC callers (including sandboxed tools) from claiming desktop
 * commands. Same-OS-user processes with direct access to Pico's private state
 * directory remain outside this security boundary.
 */
export async function rotateDesktopClientToken(picoHome: string): Promise<string> {
  await ensurePrivateDirectory(picoHome);
  const path = join(picoHome, FILE_NAME);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error("Desktop 客户端能力凭据文件不安全");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  await writePrivateFileAtomic(path, `${token}\n`);
  return token;
}

export function revokeDesktopClientToken(picoHome: string, token: string): void {
  try {
    const path = join(picoHome, FILE_NAME);
    if (readFileSync(path, "utf8").trim() === token) {
      rmSync(path, { force: true });
    }
  } catch {
    // A missing or replaced token is already unusable by this client.
  }
}

export async function loadDesktopClientToken(picoHome: string): Promise<string> {
  await ensurePrivateDirectory(picoHome);
  const path = join(picoHome, FILE_NAME);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new Error("Desktop 客户端能力凭据文件不安全");
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) {
      throw new Error("Desktop 客户端能力凭据已替换");
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("Desktop 客户端能力凭据无效");
    return token;
  } finally {
    await handle.close();
  }
}
