import { resolve } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { MemoryRepository } from "./memory-repository.js";
import type { TerminalMemoryEvidenceRef } from "./proposal-contracts.js";
import { MEMORY_PROPOSAL_EXTRACTOR_VERSION, MEMORY_PROPOSAL_JOB_TYPE } from "./proposal-contracts.js";
import {
  MEMORY_SCAN_SESSION_PAGE_SIZE,
  readCanonicalRecoveryRefs,
} from "../runtime/memory-review-recovery.js";
import {
  RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
  RuntimeEventStore,
} from "../storage/runtime-event-store.js";

const REBUILD_BATCH_SIZE = 25;

/**
 * 从 RuntimeEventStore 重建 Memory 的派生层（Source + extraction Jobs）。
 *
 * 派生层是 RuntimeEvent 的投影——Source 的 eventIds/digest/evidenceRef 全部来自 RuntimeEvent。
 * 如果 memory/state.json 损坏，派生层可从此函数重建；overlay 层（Settings/manual-fact/
 * Fact state/裁决/审计）属于"用户意图"，需从备份恢复，本函数不触碰。
 *
 * 幂等性：对每个 canonical completed terminal，按 `terminalEventId + extractorVersion`
 * 去重——MemoryRepository.createJob 本身就会把重复 (terminalEventId, extractorVersion)
 * 视作同一 Job 返回。多次调用此函数结果一致（不会重复入队）。
 *
 * 不重新跑 proposal-engine：Fact 正文是模型有损投影，不保证一致；只补回 queued Job，
 * 让后续的 review worker 决定是否重新提取。Source 在 Job 成功提交候选时由
 * proposal-engine.commitExtraction 重新创建（createSource 同样幂等，sourceId 来自 evidence digest）。
 */
export interface MemoryRebuildReport {
  readonly scannedSessions: number;
  readonly scannedTerminals: number;
  readonly rebuiltSources: number;
  readonly enqueuedJobs: number;
  readonly skippedExisting: number;
  readonly errors: readonly string[];
}

export interface MemoryRebuildOptions {
  /**
   * Optional extractor version to dedupe against. Defaults to the current proposal extractor so
   * rebuild only enqueues terminals whose latest extraction is missing.
   */
  readonly extractorVersion?: string;
  /** Optional page-size override, mainly for tests. */
  readonly sessionPageSize?: number;
}

export async function rebuildDerivedFromRuntimeEvent(
  repository: MemoryRepository,
  runtimeEventStore: RuntimeEventStore,
  workspaceRoot: string,
  options: MemoryRebuildOptions = {},
): Promise<MemoryRebuildReport> {
  const extractorVersion = options.extractorVersion ?? MEMORY_PROPOSAL_EXTRACTOR_VERSION;
  const sessionPageSize = options.sessionPageSize ?? MEMORY_SCAN_SESSION_PAGE_SIZE;
  // `workspaceRoot` is the Pico workspace storage root (resolvePicoPaths(...).workspace.root);
  // we accept it for symmetry with recoverMemoryReviewJobs but the scan reads from the supplied
  // RuntimeEventStore, which already binds its own storageRoot.
  void resolve(workspaceRoot);

  let scannedSessions = 0;
  let scannedTerminals = 0;
  let rebuiltSources = 0;
  let enqueuedJobs = 0;
  let skippedExisting = 0;
  const errors: string[] = [];

  const settings = repository.getSettings();
  // Memory disabled at the overlay level: derived layer still exists as a projection, but enqueuing
  // new extraction jobs would be a no-op (worker returns disabled). Skip the scan entirely so the
  // report reflects reality and we don't churn the jobs ledger for a disabled workspace.
  if (!settings.enabled || !settings.autoPropose) {
    return { scannedSessions, scannedTerminals, rebuiltSources, enqueuedJobs, skippedExisting, errors };
  }

  const upperBound = await runtimeEventStore.getSessionManifestScanUpperBound();
  if (!upperBound) {
    return { scannedSessions, scannedTerminals, rebuiltSources, enqueuedJobs, skippedExisting, errors };
  }

  let before:
    | {
        readonly createdAt: string;
        readonly sessionId: string;
      }
    | undefined;
  while (true) {
    const manifests = await runtimeEventStore.listSessionManifestsPage({
      upperBound,
      ...(before ? { before } : {}),
      limit: sessionPageSize,
    });
    if (manifests.length === 0) break;
    for (const manifest of manifests) {
      scannedSessions++;
      let refs: TerminalMemoryEvidenceRef[];
      try {
        refs = await readCanonicalRecoveryRefs(runtimeEventStore, manifest.sessionId);
      } catch (error) {
        errors.push(
          `session ${manifest.sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      for (const ref of refs) {
        scannedTerminals++;
        try {
          const result = enqueueTerminalIfMissing(repository, ref, extractorVersion);
          if (result.enqueued) enqueuedJobs++;
          else skippedExisting++;
        } catch (error) {
          errors.push(
            `terminal ${ref.terminalEventId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await yieldToHost();
    }
    const last = manifests.at(-1)!;
    before = { createdAt: last.createdAt, sessionId: last.sessionId };
    await yieldToHost();
    if (manifests.length < sessionPageSize) break;
  }

  return { scannedSessions, scannedTerminals, rebuiltSources, enqueuedJobs, skippedExisting, errors };
}

interface EnqueueTerminalOutcome {
  readonly enqueued: boolean;
}

/**
 * Idempotently enqueues a `queued` extraction Job for one canonical terminal.
 *
 * MemoryRepository.createJob dedupes on `(terminalEventId, extractorVersion)`: if a Job already
 * exists for this terminal+extractor pair it is returned unchanged (status preserved). We additionally
 * list existing Jobs first so we can distinguish a true new enqueue from an existing Job and avoid
 * touching a Job that already reached a terminal status (succeeded/cancelled) — those reflect prior
 * overlay decisions and must not be reset.
 *
 * Source rebuild is not performed here: a Source is created by proposal-engine.commitExtraction as
 * part of the same transaction that writes Proposals. Re-running the model would not reproduce the
 * same body text (lossy projection), so the rebuild path deliberately leaves Source creation to the
 * worker. `rebuiltSources` in the report is therefore reserved for future use and currently always 0.
 */
function enqueueTerminalIfMissing(
  repository: MemoryRepository,
  ref: TerminalMemoryEvidenceRef,
  extractorVersion: string,
): EnqueueTerminalOutcome {
  const existing = repository.listJobs({
    type: MEMORY_PROPOSAL_JOB_TYPE,
    extractorVersion,
    limit: REBUILD_BATCH_SIZE,
  });
  const matched = existing.find((job) => job.terminalEventId === ref.terminalEventId);
  if (matched) {
    // An existing Job for this (terminalEventId, extractorVersion) already encodes the overlay's
    // decision (succeeded = extracted; cancelled = suppressed; failed = retryable). Do not reset.
    return { enqueued: false };
  }
  // createJob is idempotent on (terminalEventId, extractorVersion): if a concurrent writer created
  // the same Job between our listJobs and createJob, the repository returns the existing Job and we
  // correctly report it as not-enqueued-by-this-call.
  const created = repository.createJob({
    type: MEMORY_PROPOSAL_JOB_TYPE,
    terminalEventId: ref.terminalEventId,
    extractorVersion,
    cursor: {
      sessionId: ref.sessionId,
      eventId: ref.userMessageEventId,
      ...(ref.terminalSequence !== undefined ? { sequence: ref.terminalSequence } : {}),
    },
    idempotencyKey: `memory-rebuild:${ref.terminalEventId}:${ref.userMessageEventId}`,
  });
  // If createJob returned a Job that is already in a non-queued status it must have pre-existed;
  // treat as skipped rather than freshly enqueued so repeated rebuilds stay idempotent.
  const enqueued = created.status === "queued" && created.attemptCount === 0;
  return { enqueued };
}

/**
 * The maximum page size enforced by RuntimeEventStore for sequence scans. Exported for tests that
 * build ledgers large enough to require paging through `readCanonicalRecoveryRefs`.
 */
export const REBUILD_RUNTIME_PAGE_SIZE = RUNTIME_EVENT_STORE_MAX_PAGE_SIZE;
