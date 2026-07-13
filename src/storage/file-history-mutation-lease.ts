import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve } from "node:path";
import { LeaseConflictError, OwnerLease } from "./owner-lease.js";

const FILE_HISTORY_MUTATION_LEASE_NAME = "cas-mutation";
const activeMutationLeases = new AsyncLocalStorage<ReadonlySet<string>>();
const localMutationTails = new Map<string, Promise<void>>();

export interface FileHistoryMutationLeaseOptions {
  /** GC 等保守维护操作可设为 false，冲突时立即放弃。 */
  readonly waitForExternalLease?: boolean;
  readonly timeoutMs?: number;
  readonly retryIntervalMs?: number;
}

/**
 * CAS blob 引用的共享写者锁。任何可能新增或移除 File History
 * manifest / operation journal 引用的操作，都必须与 GC apply 使用同一目录。
 */
export function fileHistoryMutationLeaseDirectory(baseDir: string): string {
  return join(resolve(baseDir), ".leases", FILE_HISTORY_MUTATION_LEASE_NAME);
}

/**
 * 把“创建 CAS 内容 + 发布引用”组成一个互斥的耐久临界区。
 * 同一进程内的独立操作先按 baseDir 排队，再竞争跨进程 OwnerLease；
 * 同一 async 调用链嵌套取锁则立即失败，避免死锁并强制调用方在最外层组合发布。
 */
export async function withFileHistoryMutationLease<T>(
  baseDir: string,
  ownerId: string,
  operation: (lease: OwnerLease) => Promise<T>,
  options: FileHistoryMutationLeaseOptions = {},
): Promise<T> {
  const leaseDirectory = fileHistoryMutationLeaseDirectory(baseDir);
  if (activeMutationLeases.getStore()?.has(leaseDirectory)) {
    throw new LeaseConflictError(`Mutation lease is already held by this operation: ${ownerId}`);
  }

  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolveTurn) => {
    releaseTurn = resolveTurn;
  });
  const previous = localMutationTails.get(leaseDirectory) ?? Promise.resolve();
  const tail = previous.catch(() => undefined).then(() => turn);
  localMutationTails.set(leaseDirectory, tail);
  await previous.catch(() => undefined);

  let lease: OwnerLease | undefined;
  try {
    lease = await acquireMutationLease(leaseDirectory, ownerId, options);
    const parent = activeMutationLeases.getStore();
    const scope = new Set(parent ?? []);
    scope.add(leaseDirectory);
    return await activeMutationLeases.run(scope, () => operation(lease!));
  } finally {
    try {
      await lease?.release();
    } finally {
      releaseTurn();
      if (localMutationTails.get(leaseDirectory) === tail) {
        localMutationTails.delete(leaseDirectory);
      }
    }
  }
}

async function acquireMutationLease(
  leaseDirectory: string,
  ownerId: string,
  options: FileHistoryMutationLeaseOptions,
): Promise<OwnerLease> {
  const wait = options.waitForExternalLease !== false;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryIntervalMs = options.retryIntervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await OwnerLease.acquire({ leaseDirectory, ownerId, staleAfterMs: 1_000 });
    } catch (error) {
      if (!(error instanceof LeaseConflictError) || !wait || Date.now() >= deadline) throw error;
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, retryIntervalMs));
    }
  }
}
