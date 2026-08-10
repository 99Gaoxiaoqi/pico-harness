import { resolve } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { Message } from "../schema/message.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import {
  RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
  RuntimeEventStore,
} from "../storage/runtime-event-store.js";
import type { MemoryReviewSchedulerPort } from "../memory/runtime-scheduler.js";
import type { TerminalMemoryEvidenceRef } from "../memory/proposal-contracts.js";

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
  const store = new RuntimeEventStore({ storageRoot: input.runtimeStorageRoot });
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
 * Reads the canonical completed-turn {@link TerminalMemoryEvidenceRef}s for one Session by replaying
 * its RuntimeEvent ledger through the same compact projection used by the daemon.
 *
 * Shared by crash-recovery (`recoverMemoryReviewJobs`) and Memory derived-layer rebuild
 * (`rebuildDerivedFromRuntimeEvent`) so both paths converge on the same "what is a completed turn?"
 * definition. The result is the canonical set of terminals whose extraction Jobs are eligible.
 */
export async function readCanonicalRecoveryRefs(
  store: RuntimeEventStore,
  sessionId: string,
): Promise<TerminalMemoryEvidenceRef[]> {
  const projection = new CompactRecoveryProjection(sessionId);
  let afterSequence = 0;
  while (true) {
    const entries = await store.readSessionEntriesPage(sessionId, {
      afterSequence,
      limit: RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
    });
    if (entries.length === 0) break;
    for (const entry of entries) projection.append(entry);
    afterSequence = entries.at(-1)!.sequence;
    await yieldToHost();
    if (entries.length < RUNTIME_EVENT_STORE_MAX_PAGE_SIZE) break;
  }
  return projection.refs();
}

interface CompactEvidence {
  readonly eventId: string;
  readonly content: string;
}

interface CompactRunState {
  readonly priorDesktopEvidence?: CompactEvidence;
  readonly directUser?: CompactEvidence;
  readonly hasAssistantResponse: boolean;
}

interface RecoveryRefNode {
  readonly ref: TerminalMemoryEvidenceRef;
  readonly previous?: RecoveryRefNode;
}

/**
 * Compact projection that retains only active runs and accumulated evidence refs as the
 * RuntimeEvent ledger is replayed. The destructive rewind/branch snapshot-restore logic that
 * previously lived here has been removed (rewind is now a non-destructive fork).
 */
class CompactRecoveryProjection {
  private latestDesktopEvidence: CompactEvidence | undefined;
  private runs = new Map<string, CompactRunState>();
  private refsTail: RecoveryRefNode | undefined;

  constructor(private readonly sessionId: string) {}

  append(entry: RuntimeEventStoreEntry): void {
    const { event } = entry;
    if (event.kind === "run.started") {
      this.runs.set(event.runId, {
        ...(this.latestDesktopEvidence ? { priorDesktopEvidence: this.latestDesktopEvidence } : {}),
        hasAssistantResponse: false,
      });
    } else if (isModelMessage(entry) && event.kind === "message.committed") {
      const current = this.runs.get(event.runId);
      if (current) {
        const directUser =
          current.directUser ??
          (isModelUserMessage(entry) &&
          event.data.message.providerData?.["picoKind"] === undefined &&
          event.data.message.providerData?.["picoHiddenFromTranscript"] !== true
            ? { eventId: event.eventId, content: event.data.message.content }
            : undefined);
        this.runs.set(event.runId, {
          ...(current.priorDesktopEvidence
            ? { priorDesktopEvidence: current.priorDesktopEvidence }
            : {}),
          ...(directUser ? { directUser } : {}),
          hasAssistantResponse:
            current.hasAssistantResponse || event.data.message.role === "assistant",
        });
      }
      const desktopContent = strictDesktopInputText(event.data.message);
      this.latestDesktopEvidence = desktopContent
        ? { eventId: event.eventId, content: desktopContent }
        : undefined;
    } else if (event.kind === "run.terminal") {
      const run = this.runs.get(event.runId);
      if (
        run?.hasAssistantResponse &&
        event.data.status === "completed" &&
        event.data.recovered !== true
      ) {
        const evidence = run.directUser ?? run.priorDesktopEvidence;
        if (evidence) {
          const ref: TerminalMemoryEvidenceRef = {
            sessionId: this.sessionId,
            runId: event.runId,
            terminalEventId: event.eventId,
            userMessageEventId: evidence.eventId,
            terminalSequence: entry.sequence,
          };
          this.refsTail = { ref, ...(this.refsTail ? { previous: this.refsTail } : {}) };
        }
      }
      // A terminal Run can no longer receive canonical messages.
      this.runs.delete(event.runId);
    }
  }

  refs(): TerminalMemoryEvidenceRef[] {
    const reversed: TerminalMemoryEvidenceRef[] = [];
    for (let node = this.refsTail; node; node = node.previous) reversed.push(node.ref);
    return reversed.reverse();
  }
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

function isModelUserMessage(entry: RuntimeEventStoreEntry): boolean {
  return (
    isModelMessage(entry) &&
    entry.event.kind === "message.committed" &&
    entry.event.data.message.role === "user" &&
    entry.event.data.message.toolCallId === undefined
  );
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
