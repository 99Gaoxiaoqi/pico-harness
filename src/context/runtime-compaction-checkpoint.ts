import { createHash, randomUUID } from "node:crypto";
import type { EngineRuntimeRun } from "../engine/runtime-port.js";
import type { Session } from "../engine/session.js";
import type { HookService } from "../hooks/service.js";
import { logger } from "../observability/logger.js";
import type {
  FullCompactionPreview,
  FullCompactionRequest,
  FullCompactor,
} from "./full-compactor.js";

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

  const source = request.trigger === "manual" ? "manual" : "auto";
  await hookService?.dispatch("PreCompact", { source, messageCount: entries.length }, { signal });
  const preview = await compactor.preview(
    session,
    entries.map(({ message }) => message),
    request,
    signal,
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
    sourceDigest: createHash("sha256")
      .update(covered.map(({ eventId }) => eventId).join("\n"))
      .digest("hex"),
    throughEventId: through.eventId,
    summary: {
      role: "assistant",
      content: preview.wrappedSummary,
      providerData: { picoKind: "runtime_checkpoint", picoCheckpointId: checkpointId },
    },
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
