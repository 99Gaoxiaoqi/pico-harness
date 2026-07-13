import { join, resolve } from "node:path";
import { OwnerLease } from "./owner-lease.js";

const FILE_HISTORY_MUTATION_LEASE_NAME = "cas-mutation";

/**
 * CAS blob 引用的共享写者锁。任何可能新增或移除 File History
 * manifest / operation journal 引用的操作，都必须与 GC apply 使用同一目录。
 */
export function fileHistoryMutationLeaseDirectory(baseDir: string): string {
  return join(resolve(baseDir), ".leases", FILE_HISTORY_MUTATION_LEASE_NAME);
}

/**
 * 把“创建 CAS 内容 + 发布引用”组成一个互斥的耐久临界区。
 * 该 helper 故意不做进程内可重入：调用方应在最外层组合完整发布操作。
 */
export async function withFileHistoryMutationLease<T>(
  baseDir: string,
  ownerId: string,
  operation: (lease: OwnerLease) => Promise<T>,
): Promise<T> {
  const lease = await OwnerLease.acquire({
    leaseDirectory: fileHistoryMutationLeaseDirectory(baseDir),
    ownerId,
  });
  try {
    return await operation(lease);
  } finally {
    await lease.release();
  }
}
