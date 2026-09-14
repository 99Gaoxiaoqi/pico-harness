import { randomUUID } from "node:crypto";
import {
  CONTENT_DIGEST_V1_PREFIX,
  computeCheckpointSourceDigest,
  type CheckpointDigestEntry,
} from "@pico/core";
import type {
  FullCompactionPreview,
  FullCompactionRequest,
  FullCompactor,
  RuntimeFullCompactionHookService,
  RuntimeFullCompactionSessionIdentity,
} from "./full-compactor.js";
import type {
  RuntimeCheckpointInput,
  RuntimeHistoryEntry,
  RuntimeLastCompactionCheckpoint,
} from "./runtime-port-contract.js";

/** @deprecated checkpoint 内容摘要契约已移至 @pico/core。 */
export { CONTENT_DIGEST_V1_PREFIX, computeCheckpointSourceDigest };
export type { CheckpointDigestEntry };

/** Host-provided observability; Runtime does not depend on a logging implementation. */
export interface RuntimeCompactionCheckpointLogger {
  warn(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

const NOOP_LOGGER: RuntimeCompactionCheckpointLogger = {
  warn: () => undefined,
};

/** Narrow Runtime run capability needed to materialize and commit one checkpoint. */
export interface RuntimeCompactionCheckpointRun<Session> {
  claimsSession(session: Session): boolean;
  readModelHistoryEntries(): Promise<readonly RuntimeHistoryEntry[]>;
  findLastCompactionCheckpoint(): Promise<RuntimeLastCompactionCheckpoint | undefined>;
  recordCheckpoint(input: RuntimeCheckpointInput): Promise<void>;
}

export interface RuntimeCompactionCheckpointResult {
  readonly checkpointId: string;
  readonly preview: FullCompactionPreview;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
}

export interface RuntimeCompactionCheckpointOptions<
  Session extends RuntimeFullCompactionSessionIdentity,
> {
  readonly session: Session;
  readonly runtimeRun: RuntimeCompactionCheckpointRun<Session>;
  readonly compactor: FullCompactor;
  readonly request: FullCompactionRequest;
  readonly hookService?: RuntimeFullCompactionHookService;
  readonly memoryDisposition?: () => Promise<"eligible" | "policy_denied" | undefined>;
  readonly signal?: AbortSignal;
  readonly logger?: RuntimeCompactionCheckpointLogger;
}

/**
 * Generate and durably record a rolling Runtime checkpoint without rewriting
 * Session history. Runtime facts remain immutable; only the model read model
 * replaces the covered prefix with the generated summary.
 */
export async function recordRuntimeCompactionCheckpoint<
  Session extends RuntimeFullCompactionSessionIdentity,
>(
  options: RuntimeCompactionCheckpointOptions<Session>,
): Promise<RuntimeCompactionCheckpointResult | undefined> {
  const { session, runtimeRun, compactor, request, hookService, signal } = options;
  const logger = options.logger ?? NOOP_LOGGER;
  signal?.throwIfAborted();
  if (!runtimeRun.claimsSession(session)) {
    throw new Error(`Runtime compaction run does not own Session ${session.id}`);
  }

  const entries = await runtimeRun.readModelHistoryEntries();
  if (entries.length < 2) return undefined;

  // 滚动摘要:读取上一个 checkpoint,启用增量更新而非重算全部前缀。
  const lastCheckpoint = await runtimeRun.findLastCompactionCheckpoint().catch((err: unknown) => {
    logger.warn(
      { err: String(err), sessionId: session.id },
      "[RuntimeCompaction] findLastCompactionCheckpoint 失败,退回全量摘要",
    );
    return undefined;
  });

  const source = request.trigger === "manual" ? "manual" : "auto";
  await hookService?.dispatch(
    "PreCompact",
    { source, messageCount: entries.length },
    signal ? { signal } : {},
  );
  const preview = await compactor.preview(
    session,
    entries.map(({ message }) => message),
    request,
    signal,
    lastCheckpoint?.summaryText,
  );
  if (!preview) return undefined;

  signal?.throwIfAborted();
  const covered = entries.slice(0, preview.compactedCount);
  const through = covered.at(-1);
  if (!through) return undefined;
  if (through.compactionBoundarySafe === false) {
    logger.warn(
      { sessionId: session.id, throughEventId: through.eventId },
      "[RuntimeCompaction] 跳过会拆分中断恢复历史的压缩边界",
    );
    return undefined;
  }

  const checkpointId = `checkpoint:${randomUUID()}`;
  let disposition: "eligible" | "policy_denied" | undefined;
  try {
    disposition = await options.memoryDisposition?.();
  } catch (error) {
    // Temporary memory failures must not prevent the ordinary context checkpoint.
    // Eligibility only permits recovery; extraction still checks live policy.
    disposition = "eligible";
    logger.warn(
      { error: String(error), checkpointId },
      "[Memory] checkpoint admission unavailable; recovery deferred",
    );
  }
  await runtimeRun.recordCheckpoint({
    checkpointId,
    coveredEventCount: covered.length,
    sourceDigest: computeCheckpointSourceDigest(covered),
    throughEventId: through.eventId,
    ...(disposition
      ? { memoryExtractionBoundary: { runtimeEventId: through.eventId, disposition } }
      : {}),
    summary: {
      role: "assistant",
      content: preview.wrappedSummary,
      providerData: { picoKind: "runtime_checkpoint", picoCheckpointId: checkpointId },
    },
    ...(lastCheckpoint ? { previousCheckpointId: lastCheckpoint.checkpointId } : {}),
  });

  const afterMessageCount = (await runtimeRun.readModelHistoryEntries()).length;
  try {
    await hookService?.dispatch(
      "PostCompact",
      { source, messageCount: afterMessageCount },
      signal ? { signal } : {},
    );
  } catch (error) {
    logger.warn(
      { err: String(error), sessionId: session.id, checkpointId },
      "[RuntimeCompaction] checkpoint 已提交，PostCompact 派发失败",
    );
  }

  return {
    checkpointId,
    preview,
    beforeMessageCount: entries.length,
    afterMessageCount,
  };
}
