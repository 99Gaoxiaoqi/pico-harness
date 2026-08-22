import { StorageRootAuthorityError } from "./control/root-authority.js";

/**
 * Candidate 启动失败的退出码协议（移植自参考宿主实现的 fast-fail 机制）：
 * candidate 把启动失败分类后以专属退出码退出，launcher 监听 exit 反查回失败
 * 对象交给 connectOrSpawn——永久性失败立即刹车返回，不再空转烧完选举窗口。
 *
 * 永久/非永久的边界是"同一窗口内重试是否永远无效"：存储根身份类错误是确定
 * 性的（marker 与 expectedRootId 对不上，重拉候选也一样）；legacy 守卫拒绝
 * 与内部启动失败不是（旧 daemon 会退、环境会变），只上报不刹车。
 */
export type CandidateStartupFailureReason =
  | "storage_root_incompatible"
  | "legacy_daemon_running"
  | "internal_startup_failure";

export interface CandidateStartupFailure {
  readonly reason: CandidateStartupFailureReason;
}

const EXIT_CODE_BY_REASON: Readonly<Record<CandidateStartupFailureReason, number>> = {
  // sysexits: EX_DATAERR。与 flock loser(2)/legacy 守卫拒绝(3) 错开。
  storage_root_incompatible: 65,
  legacy_daemon_running: 3,
  // sysexits: EX_SOFTWARE。历史值 1 的升级：让客户端能区分"候选启动失败"
  // 与其他非协议退出（V8 崩溃等随机码）。
  internal_startup_failure: 70,
};

/** 存储根身份类错误码——marker 与客户端持有的 rootId 失配，重试无效。 */
const PERMANENT_ROOT_AUTHORITY_CODES: ReadonlySet<string> = new Set([
  "root_identity_changed",
  "root_identity_collision",
  "invalid_marker",
  "root_kind_mismatch",
]);

export function classifyCandidateStartupFailure(error: unknown): CandidateStartupFailure {
  const chain = primaryErrorChain(error);
  if (
    chain.some(
      (candidate) =>
        candidate instanceof StorageRootAuthorityError &&
        PERMANENT_ROOT_AUTHORITY_CODES.has(candidate.code),
    )
  ) {
    return { reason: "storage_root_incompatible" };
  }
  return { reason: "internal_startup_failure" };
}

export function isPermanentCandidateStartupFailure(
  failure: CandidateStartupFailure | undefined,
): failure is CandidateStartupFailure & {
  readonly reason: "storage_root_incompatible";
} {
  return failure !== undefined && failure.reason === "storage_root_incompatible";
}

export function candidateStartupFailureExitCode(failure: CandidateStartupFailure): number {
  return EXIT_CODE_BY_REASON[failure.reason];
}

export function candidateStartupFailureForExitCode(
  exitCode: number | null,
): CandidateStartupFailure | undefined {
  for (const [reason, code] of Object.entries(EXIT_CODE_BY_REASON)) {
    if (exitCode === code) return { reason: reason as CandidateStartupFailureReason };
  }
  return undefined;
}

function primaryErrorChain(root: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<object>();
  let value: unknown = root;
  for (;;) {
    chain.push(value);
    if (typeof value !== "object" || value === null || visited.has(value)) break;
    visited.add(value);
    if ("cause" in value) {
      const cause = (value as { cause?: unknown }).cause;
      if (cause !== undefined) {
        value = cause;
        continue;
      }
    }
    if (value instanceof AggregateError && value.errors.length > 0) {
      value = value.errors[0]!;
      continue;
    }
    break;
  }
  return chain;
}
