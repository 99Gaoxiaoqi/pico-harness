import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Windows 上安全软件/索引器会间歇性持有刚写入文件的句柄（无 FILE_SHARE_DELETE），
 * 使 tmp→final 的 rename 以 EPERM/EACCES 失败——真机事故（2026-08-16）：daemon
 * candidate 在 registration 发布时撞上 EPERM 直接崩溃，烧掉整个选举窗口。此类
 * 占用是亚秒级瞬态，有界重试即可穿越；非瞬态错误（如目标目录消失）照常上抛。
 */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

export async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    }
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isTransientFsError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isTransientFsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    TRANSIENT_FS_CODES.has((error as NodeJS.ErrnoException).code ?? "")
  );
}
