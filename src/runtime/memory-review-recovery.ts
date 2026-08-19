import { resolve } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { Message } from "../schema/message.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store-contracts.js";
import type { MemoryReviewSchedulerPort } from "../memory/runtime-scheduler.js";
import type { TerminalMemoryEvidenceRef } from "../memory/proposal-contracts.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";

export interface RecoverMemoryReviewJobsInput {
  readonly runtimeStorageRoot: string;
  readonly scheduler: MemoryReviewSchedulerPort;
}

const RECOVERY_SESSION_PAGE_SIZE = 25;
const RECOVERY_ENQUEUE_BATCH_SIZE = 25;

/** Page size shared by recovery and rebuild scans when walking session manifests. */
export const MEMORY_SCAN_SESSION_PAGE_SIZE = RECOVERY_SESSION_PAGE_SIZE;
const successfulRecoveryDatabases = new Set<string>();
interface RecoveryFlight {
  readonly promise: Promise<number>;
}

const recoveryFlights = new Map<string, RecoveryFlight>();
const recoveryGenerations = new Map<string, number>();

/** Invalidates only this process's successful-scan marker for one Runtime storage root. */
export function invalidateMemoryReviewRecoverySuccess(runtimeStorageRoot: string): void {
  const storageRoot = resolve(runtimeStorageRoot);
  successfulRecoveryDatabases.delete(storageRoot);
  recoveryGenerations.set(storageRoot, (recoveryGenerations.get(storageRoot) ?? 0) + 1);
}

/**
 * Replays canonical completed turns through the idempotent review scheduler. This closes the
 * crash window after run.terminal is durable but before the Memory job reaches its own database.
 */
export function recoverMemoryReviewJobs(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const storageRoot = resolve(input.runtimeStorageRoot);
  if (successfulRecoveryDatabases.has(storageRoot)) return Promise.resolve(0);
  const generation = recoveryGenerations.get(storageRoot) ?? 0;
  const inFlight = recoveryFlights.get(storageRoot);
  if (inFlight) return inFlight.promise;

  // Begin in a later host task so opening file storage never extends the caller's synchronous path.
  const scan = yieldToHost()
    .then(() => scanRuntimeLedger({ ...input, runtimeStorageRoot: storageRoot }))
    .then((recovered) => {
      if ((recoveryGenerations.get(storageRoot) ?? 0) === generation) {
        successfulRecoveryDatabases.add(storageRoot);
      }
      return recovered;
    });
  const flight: RecoveryFlight = {
    promise: scan
      .finally(() => {
        if (recoveryFlights.get(storageRoot) === flight) recoveryFlights.delete(storageRoot);
      })
      .then(async (recovered) => {
        if (successfulRecoveryDatabases.has(storageRoot)) return recovered;
        // An enqueue failure can invalidate this generation while its scan is still running. The
        // The stale scan has released the file lock and its flight slot, so immediately continue with the
        // current generation instead of making another foreground Run discover the gap. A failed
        // scan rejects before this continuation and therefore keeps the existing failure semantics.
        return recovered + (await recoverMemoryReviewJobs(input));
      }),
  };
  recoveryFlights.set(storageRoot, flight);
  return flight.promise;
}

async function scanRuntimeLedger(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const store = new SqliteRuntimeEventStore({ storageRoot: input.runtimeStorageRoot });
  let recovered = 0;
  try {
    const upperBound = await store.getSessionManifestScanUpperBound();
    if (!upperBound) return 0;
    let before:
      | {
          readonly createdAt: string;
          readonly sessionId: string;
        }
      | undefined;
    while (true) {
      const manifests = await store.listSessionManifestsPage({
        upperBound,
        ...(before ? { before } : {}),
        limit: RECOVERY_SESSION_PAGE_SIZE,
      });
      if (manifests.length === 0) break;
      for (const manifest of manifests) {
        const refs = await readCanonicalRecoveryRefs(store, manifest.sessionId);
        for (const [index, ref] of refs.entries()) {
          await input.scheduler.enqueue(ref);
          recovered++;
          if ((index + 1) % RECOVERY_ENQUEUE_BATCH_SIZE === 0) await yieldToHost();
        }
      }
      const last = manifests.at(-1)!;
      before = { createdAt: last.createdAt, sessionId: last.sessionId };
      await yieldToHost();
      if (manifests.length < RECOVERY_SESSION_PAGE_SIZE) break;
    }
  } finally {
    store.close();
  }
  return recovered;
}

/**
 * Reads the canonical completed-turn {@link TerminalMemoryEvidenceRef}s for one Session.
 *
 * Query-based (票 07):terminal 事件经 kind 索引一次取出;每个 completed terminal
 * 用 run 索引做三次有界查询(run.started 定界、run 内模型消息、必要时 run 前
 * 最近一条桌面输入),不再全量重放会话账本。"什么是一个完成的 turn" 的定义与
 * 旧 CompactRecoveryProjection 逐事件重放完全一致:
 * - run.started 时刻捕获 priorDesktopEvidence(run 前最后一条模型消息携带的
 *   desktop_user_input;displayText 之外的消息会清除该状态);
 * - run 内首条合格直述用户消息(directUser)优��于 priorDesktopEvidence;
 * - terminal 必须为 completed 且非 recovered,且 run 内出现过 assistant 消息。
 *
 * Shared by crash-recovery (`recoverMemoryReviewJobs`) and Memory derived-layer rebuild
 * (`rebuildDerivedFromRuntimeEvent`) so both paths converge on the same definition.
 */
export async function readCanonicalRecoveryRefs(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<TerminalMemoryEvidenceRef[]> {
  const terminals = await store.readSessionEventsByKind(sessionId, "run.terminal");
  const refs: TerminalMemoryEvidenceRef[] = [];
  for (const [index, terminal] of terminals.entries()) {
    const ref = await resolveCompletedTerminalRef(store, sessionId, terminal);
    if (ref) refs.push(ref);
    if ((index + 1) % RECOVERY_ENQUEUE_BATCH_SIZE === 0) await yieldToHost();
  }
  return refs;
}

interface CompactEvidence {
  readonly eventId: string;
  readonly content: string;
}

async function resolveCompletedTerminalRef(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  terminalEntry: RuntimeEventStoreEntry,
): Promise<TerminalMemoryEvidenceRef | undefined> {
  const terminal = terminalEntry.event;
  if (terminal.kind !== "run.terminal") return undefined;
  if (terminal.data.status !== "completed" || terminal.data.recovered === true) return undefined;
  // 旧投影只认 run.started 之后进入 runs 表的 run;取 terminal 前最后一条 run.started。
  const startedEntries = await store.readSessionEventsForRun(sessionId, terminal.runId, {
    kind: "run.started",
    beforeSequence: terminalEntry.sequence,
    order: "desc",
    limit: 1,
  });
  const startedEntry = startedEntries[0];
  if (!startedEntry) return undefined;
  const runMessages = await store.readSessionEventsForRun(sessionId, terminal.runId, {
    kind: "message.committed",
    afterSequence: startedEntry.sequence,
    beforeSequence: terminalEntry.sequence,
    modelOnly: true,
  });
  let directUser: CompactEvidence | undefined;
  let hasAssistantResponse = false;
  for (const { event } of runMessages) {
    if (event.kind !== "message.committed") continue;
    const message = event.data.message;
    if (
      directUser === undefined &&
      message.role === "user" &&
      message.toolCallId === undefined &&
      message.providerData?.["picoKind"] === undefined &&
      message.providerData?.["picoHiddenFromTranscript"] !== true
    ) {
      directUser = { eventId: event.eventId, content: message.content };
    }
    if (message.role === "assistant") hasAssistantResponse = true;
  }
  if (!hasAssistantResponse) return undefined;
  const evidence = directUser ?? (await readPriorDesktopEvidence(store, sessionId, startedEntry.sequence));
  if (!evidence) return undefined;
  return {
    sessionId,
    runId: terminal.runId,
    terminalEventId: terminal.eventId,
    userMessageEventId: evidence.eventId,
    terminalSequence: terminalEntry.sequence,
  };
}

/**
 * run.started 之前最后一条模型消息:若它是合格 desktop_user_input(与投影内
 * strictDesktopInputText 同口径)则为 priorDesktopEvidence,否则该状态被清除。
 */
async function readPriorDesktopEvidence(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  startedSequence: number,
): Promise<CompactEvidence | undefined> {
  if (startedSequence <= 1) return undefined;
  const entries = await store.readSessionEventsByKind(sessionId, "message.committed", {
    upToSequence: startedSequence - 1,
    order: "desc",
    limit: 1,
    modelOnly: true,
  });
  const entry = entries[0];
  if (!entry || entry.event.kind !== "message.committed") return undefined;
  const content = strictDesktopInputText(entry.event.data.message);
  return content ? { eventId: entry.event.eventId, content } : undefined;
}

export function findPrecommittedDesktopMemoryEvidence(
  entries: readonly RuntimeEventStoreEntry[],
  runId: string,
  prompt: string,
): { readonly eventId: string; readonly content: string } | undefined {
  if (!prompt.trim()) return undefined;
  const startedSequence = entries.find(
    (entry) => entry.event.kind === "run.started" && entry.event.runId === runId,
  )?.sequence;
  if (startedSequence === undefined) return undefined;
  const latestModelMessage = entries.findLast(
    (entry) => entry.sequence < startedSequence && isModelMessage(entry),
  );
  if (latestModelMessage?.event.kind !== "message.committed") return undefined;
  const content = strictDesktopInputText(latestModelMessage.event.data.message, prompt);
  return content ? { eventId: latestModelMessage.event.eventId, content } : undefined;
}

function isModelMessage(entry: RuntimeEventStoreEntry): boolean {
  return (
    entry.event.kind === "message.committed" &&
    entry.event.visibility === "model" &&
    !entry.event.partial
  );
}

function strictDesktopInputText(message: Message, expectedPrompt?: string): string | undefined {
  if (message.role !== "user" || message.toolCallId !== undefined) return undefined;
  const providerData = message.providerData;
  if (!providerData || providerData["picoKind"] !== "desktop_user_input") return undefined;
  const displayText = providerData["displayText"];
  if (typeof displayText !== "string" || !displayText.trim()) return undefined;
  // Skill/Agent expansion changes content while displayText keeps the user's original command.
  // Only an exact plain-text Desktop submission is eligible evidence.
  if (
    message.content !== displayText ||
    (expectedPrompt !== undefined && expectedPrompt !== displayText)
  ) {
    return undefined;
  }
  return displayText;
}
