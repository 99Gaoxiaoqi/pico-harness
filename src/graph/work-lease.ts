import type { SqliteRuntimeControlStore } from "../storage/sqlite/sqlite-runtime-control-store.js";

/**
 * graph work 执行主权 lease 协议（D10 归位，2026-08-16）。
 *
 * 阶段 2（D7）把 graph work 去重权威从内存 records 换成 durable lease，但协议
 * 曾住在 tools 层 DelegationManager（20 文档根因 C 批评的"tools 层承载 graph 调度"）。
 * 本模块是协议唯一实现点：常量/资源键/生命周期帮助函数。DelegationManager 与
 * graph 恢复路径共用同一模块实例——单一来源，行为零变化（纯提取）。
 *
 * 生命周期：dispatch 汇聚点 acquire → 运行期 heartbeat 续租（TTL/5 间隔）→
 * settle 链 finally release；崩溃后 TTL 过期即标孤儿（orphan 恢复按 lease 活性判定）。
 */
export const GRAPH_WORK_LEASE_TTL_MS = 5 * 60_000;
/** lease 心跳间隔（TTL/5，留 4min 余量防 I/O 抖动误过期）。 */
export const GRAPH_WORK_HEARTBEAT_MS = 60_000;

export function graphWorkLeaseKey(workId: string): string {
  return `graph-work:${workId}`;
}

export interface GraphWorkLease {
  readonly leaseEpoch: number;
}

export interface GraphWorkLeaseHolder {
  readonly ownerId?: string;
  readonly expiresAt: number;
}

/**
 * acquire 执行主权 lease：同一 work 最多一个 in-flight 委派。被他人持有
 * （TTL 未过）时抛 RuntimeConflictError——调用方按"已有活跃委派"幂等拒绝。
 */
export function acquireGraphWorkLease(
  store: SqliteRuntimeControlStore,
  workId: string,
  delegationId: string,
): GraphWorkLease {
  return store.acquireLease(graphWorkLeaseKey(workId), delegationId, GRAPH_WORK_LEASE_TTL_MS);
}

/** 当前 lease 持有者快照（无 lease 返回 undefined）。 */
export function readGraphWorkLease(
  store: SqliteRuntimeControlStore,
  workId: string,
): GraphWorkLeaseHolder | undefined {
  return store.getLease(graphWorkLeaseKey(workId));
}

/** 运行期周期续租，防长任务 delegation 让 TTL 过期被他人抢。 */
export function heartbeatGraphWorkLease(
  store: SqliteRuntimeControlStore,
  workId: string,
  delegationId: string,
  epoch: number,
): void {
  store.heartbeatLease(graphWorkLeaseKey(workId), delegationId, epoch, GRAPH_WORK_LEASE_TTL_MS);
}

/** settle 链完成时释放执行主权（best-effort：TTL 回收后 release 失败属正常）。 */
export function releaseGraphWorkLease(
  store: SqliteRuntimeControlStore,
  workId: string,
  delegationId: string,
  epoch: number,
): void {
  store.releaseLease(graphWorkLeaseKey(workId), delegationId, epoch);
}

/**
 * lease 是否仍活（TTL 未过期且有持有者）。orphan 恢复据此判定 work 的 backing
 * delegation 是否真在跑，取代"重启后 records 空集"的负信号。
 */
export function isGraphWorkLeaseLive(store: SqliteRuntimeControlStore, workId: string): boolean {
  const lease = store.getLease(graphWorkLeaseKey(workId));
  return lease ? lease.expiresAt > Date.now() : false;
}
