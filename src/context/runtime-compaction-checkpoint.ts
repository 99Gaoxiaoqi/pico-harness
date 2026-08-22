import { createHash, randomUUID } from "node:crypto";
import type { EngineRuntimeRun } from "../engine/runtime-port.js";
import type { Session } from "../engine/session.js";
import type { HookService } from "../hooks/service.js";
import { logger } from "../observability/logger.js";
import type { Message } from "../schema/message.js";
import type {
  FullCompactionPreview,
  FullCompactionRequest,
  FullCompactor,
} from "./full-compactor.js";

/** 内容哈希 digest 版本前缀,与旧格式(纯 hex eventId 序列)区分,向后兼容。 */
export const CONTENT_DIGEST_V1_PREFIX = "sha256-content:v1:";

/** covered 事件条目:用于内容哈希的最小结构。 */
export interface CheckpointDigestEntry {
  readonly eventId: string;
  readonly message: Message;
}

/**
 * 计算 checkpoint 的内容哈希 digest(对标 maka historyCompactSourceDigest)。
 *
 * 与旧逻辑(只哈希 eventId 序列)不同,这里对每个事件的 eventId + message 全内容取哈希。
 * 格式:`length:eventId\0length:body;`,用字节长度前缀 + 分隔符防前缀碰撞,
 * 字节长度而非字符长度防多字节字符漏检。
 *
 * 返回带版本前缀 `sha256-content:v1:`,便于重放端按前缀路由新旧校验逻辑。
 */
export function computeCheckpointSourceDigest(entries: readonly CheckpointDigestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const eventIdBytes = Buffer.byteLength(entry.eventId, "utf8");
    const body = JSON.stringify(entry.message);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    hash.update(String(eventIdBytes)).update(":").update(entry.eventId).update("\0");
    hash.update(String(bodyBytes)).update(":").update(body).update(";");
  }
  return CONTENT_DIGEST_V1_PREFIX + hash.digest("hex");
}

export interface RuntimeCompactionCheckpointResult {
  readonly preview: FullCompactionPreview;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
}

export interface RuntimeCompactionCheckpointOptions {
  readonly session: Session;
  readonly runtimeRun: EngineRuntimeRun;
  readonly compactor: FullCompactor;
  readonly request: FullCompactionRequest;
  readonly hookService?: HookService;
  readonly signal?: AbortSignal;
}

/**
 * Generate and durably record a rolling Runtime checkpoint without rewriting
 * Session history. Runtime facts remain immutable; only the model read model
 * replaces the covered prefix with the generated summary.
 */
export async function recordRuntimeCompactionCheckpoint(
  options: RuntimeCompactionCheckpointOptions,
): Promise<RuntimeCompactionCheckpointResult | undefined> {
  const { session, runtimeRun, compactor, request, hookService, signal } = options;
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
  await hookService?.dispatch("PreCompact", { source, messageCount: entries.length }, { signal });
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

  const checkpointId = `checkpoint:${randomUUID()}`;
  await runtimeRun.recordCheckpoint({
    checkpointId,
    coveredEventCount: covered.length,
    sourceDigest: computeCheckpointSourceDigest(covered),
    throughEventId: through.eventId,
    summary: {
      role: "assistant",
      content: preview.wrappedSummary,
      providerData: { picoKind: "runtime_checkpoint", picoCheckpointId: checkpointId },
    },
    ...(lastCheckpoint ? { previousCheckpointId: lastCheckpoint.checkpointId } : {}),
  });

  const afterMessageCount = (await runtimeRun.readModelHistoryEntries()).length;
  try {
    await hookService?.dispatch("PostCompact", {
      source,
      messageCount: afterMessageCount,
    });
  } catch (error) {
    logger.warn(
      { err: String(error), sessionId: session.id, checkpointId },
      "[RuntimeCompaction] checkpoint 已提交，PostCompact 派发失败",
    );
  }

  return {
    preview,
    beforeMessageCount: entries.length,
    afterMessageCount,
  };
}
