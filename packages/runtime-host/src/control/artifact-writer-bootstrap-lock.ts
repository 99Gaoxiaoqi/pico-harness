import { open } from "node:fs/promises";
import { tryLock, unlock } from "fs-native-extensions";

/**
 * 3-A 骨架版 marker 独占写入锁。maka 原版用于 storage root marker 的原子替换
 * （repair/import 路径）；pico 骨架阶段不触发这些路径，这里提供一个简单的
 * flock 自旋实现以保证 root-authority 可编译、语义正确。
 */
export async function withArtifactWriterBootstrapLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const handle = await open(lockPath, "a+", 0o600);
  try {
    while (!tryLock(handle.fd, { shared: false })) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await operation();
  } finally {
    try {
      unlock(handle.fd);
    } catch {
      // 关闭句柄即权威释放。
    }
    await handle.close();
  }
}
