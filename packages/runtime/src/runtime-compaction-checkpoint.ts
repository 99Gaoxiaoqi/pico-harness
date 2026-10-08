import {
  LEGACY_SECTIONED_SUMMARY_FORMAT,
  type SectionedSummaryFormat,
  findCheckpointSummaryDefect,
} from "./history-compact-summary-validation.js";
import {
  HANDOFF_EVIDENCE_METADATA_KEY,
  attachCompactionEvidenceSources,
  compactionSummarySha256,
  extractCompactionEvidenceReferences,
  isCompactionEvidenceMetadata,
  type CompactionEvidenceMetadata,
  type CompactionEvidenceResolveRequest,
  type CompactionEvidenceResolver,
} from "./compaction-handoff-evidence.js";
import { randomUUID } from "node:crypto";
import {
  CONTENT_DIGEST_V1_PREFIX,
  computeCheckpointSourceDigest,
  type CheckpointDigestEntry,
  type RuntimeMemoryExtractionBoundary,
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
  findLastCompactionCheckpoint(): Promise<
    | (RuntimeLastCompactionCheckpoint & {
        readonly summaryFormat?: SectionedSummaryFormat;
        readonly evidence?: CompactionEvidenceMetadata;
      })
    | undefined
  >;
  readonly resolveCompactionEvidenceReferences?: CompactionEvidenceResolver;
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
  readonly memoryAdmission?: () => Promise<RuntimeMemoryExtractionBoundary | undefined>;
  /** @deprecated A disposition without frozen generations cannot authorize extraction. */
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
  const lastCheckpoint = await runtimeRun.findLastCompactionCheckpoint();

  const source = request.trigger === "manual" ? "manual" : "auto";
  await hookService?.dispatch(
    "PreCompact",
    { source, messageCount: entries.length },
    signal ? { signal } : {},
  );
  let handoffEvidence: CompactionEvidenceMetadata | undefined;
  const validateSummary = async (summaryText: string, compactedCount: number) => {
    const throughEventId = entries[compactedCount - 1]?.eventId;
    const references = extractCompactionEvidenceReferences(summaryText);
    if (!throughEventId || !references) return "malformed_summary_invalid_evidence_reference";
    const input: CompactionEvidenceResolveRequest = {
      sessionId: session.id,
      throughEventId,
      ...(lastCheckpoint ? { previousCheckpointId: lastCheckpoint.checkpointId } : {}),
      summaryText,
      references,
    };
    const resolved = runtimeRun.resolveCompactionEvidenceReferences
      ? await runtimeRun.resolveCompactionEvidenceReferences(input)
      : references.length === 0
        ? {
            version: 1 as const,
            sessionId: input.sessionId,
            throughEventId: input.throughEventId,
            ...(input.previousCheckpointId
              ? { previousCheckpointId: input.previousCheckpointId }
              : {}),
            summarySha256: compactionSummarySha256(summaryText),
            references: [],
          }
        : undefined;
    if (
      !isCompactionEvidenceMetadata(resolved) ||
      resolved.sessionId !== input.sessionId ||
      resolved.throughEventId !== input.throughEventId ||
      resolved.previousCheckpointId !== input.previousCheckpointId ||
      resolved.summarySha256 !== compactionSummarySha256(summaryText) ||
      JSON.stringify(resolved.references.map(({ eventId }) => eventId)) !==
        JSON.stringify(references)
    )
      return "malformed_summary_invalid_evidence_reference";
    const additionalDefect = await request.validateSummary?.(summaryText, compactedCount);
    if (additionalDefect) return additionalDefect;
    handoffEvidence = resolved;
    return undefined;
  };
  const preview = await compactor.preview(
    session,
    entries.map(({ message }) => message),
    { ...request, sourceEventIds: entries.map(({ eventId }) => eventId), validateSummary },
    signal,
    lastCheckpoint?.summaryText &&
      !findCheckpointSummaryDefect(
        lastCheckpoint.summaryText,
        undefined,
        lastCheckpoint.summaryFormat ?? LEGACY_SECTIONED_SUMMARY_FORMAT,
      )
      ? lastCheckpoint.summaryText
      : undefined,
  );
  if (
    !preview ||
    !preview.summary.trim() ||
    findCheckpointSummaryDefect(preview.summary, undefined, preview.summaryFormat) ||
    !handoffEvidence
  )
    return undefined;

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

  // Re-resolve after preview; the final RuntimeRun commit also owns its own strong validation.
  if (await validateSummary(preview.summary, preview.compactedCount)) return undefined;
  const checkpointId = `checkpoint:${randomUUID()}`;
  let admission: RuntimeMemoryExtractionBoundary | undefined;
  try {
    if (options.memoryAdmission) {
      admission = await options.memoryAdmission();
    } else {
      const disposition = await options.memoryDisposition?.();
      if (disposition) admission = { disposition };
    }
    if (
      admission?.disposition === "eligible" &&
      (admission.deletionRevision === undefined || admission.settingsVersion === undefined)
    )
      admission = { disposition: "policy_denied" };
  } catch (error) {
    // Temporary memory failures must not prevent the ordinary context checkpoint.
    // Unknown generations cannot be refreshed into a later automatic authorization.
    admission = { disposition: "policy_denied" };
    logger.warn(
      { error: String(error), checkpointId },
      "[Memory] checkpoint admission unavailable; automatic coverage denied",
    );
  }
  await runtimeRun.recordCheckpoint({
    checkpointId,
    coveredEventCount: covered.length,
    sourceDigest: computeCheckpointSourceDigest(covered),
    throughEventId: through.eventId,
    ...(admission
      ? { memoryExtractionBoundary: { runtimeEventId: through.eventId, ...admission } }
      : {}),
    summary: {
      role: "assistant",
      content: attachCompactionEvidenceSources(preview.wrappedSummary, handoffEvidence!),
      providerData: {
        picoKind: "runtime_checkpoint",
        picoCheckpointId: checkpointId,
        picoSummaryFormat: preview.summaryFormat,
        [HANDOFF_EVIDENCE_METADATA_KEY]: handoffEvidence,
      },
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

export * from "./compaction-handoff-evidence.js";
