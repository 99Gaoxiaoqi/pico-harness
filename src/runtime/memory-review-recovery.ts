import { resolve } from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import type { Message } from "../schema/message.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { RUNTIME_EVENT_STORE_MAX_PAGE_SIZE, RuntimeEventStore } from "./runtime-event-store.js";
import { detectStableMemorySignal } from "../memory/proposal-signal.js";
import type { MemoryReviewSchedulerPort } from "../memory/runtime-scheduler.js";
import type { TerminalMemoryEvidenceRef } from "../memory/proposal-contracts.js";

export interface RecoverMemoryReviewJobsInput {
  readonly runtimeDatabasePath: string;
  readonly scheduler: MemoryReviewSchedulerPort;
}

const RECOVERY_SESSION_PAGE_SIZE = 25;
const RECOVERY_ENQUEUE_BATCH_SIZE = 25;
const successfulRecoveryDatabases = new Set<string>();
interface RecoveryFlight {
  readonly promise: Promise<number>;
}

const recoveryFlights = new Map<string, RecoveryFlight>();
const recoveryGenerations = new Map<string, number>();

/** Invalidates only this process's successful-scan marker for one Runtime database. */
export function invalidateMemoryReviewRecoverySuccess(runtimeDatabasePath: string): void {
  const databasePath = resolve(runtimeDatabasePath);
  successfulRecoveryDatabases.delete(databasePath);
  recoveryGenerations.set(databasePath, (recoveryGenerations.get(databasePath) ?? 0) + 1);
}

/**
 * Replays canonical completed turns through the idempotent review scheduler. This closes the
 * crash window after run.terminal is durable but before the Memory job reaches its own database.
 */
export function recoverMemoryReviewJobs(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const databasePath = resolve(input.runtimeDatabasePath);
  if (successfulRecoveryDatabases.has(databasePath)) return Promise.resolve(0);
  const generation = recoveryGenerations.get(databasePath) ?? 0;
  const inFlight = recoveryFlights.get(databasePath);
  if (inFlight) return inFlight.promise;

  // Begin in a later host task so opening SQLite never extends the caller's synchronous path.
  const scan = yieldToHost()
    .then(() => scanRuntimeLedger({ ...input, runtimeDatabasePath: databasePath }))
    .then((recovered) => {
      if ((recoveryGenerations.get(databasePath) ?? 0) === generation) {
        successfulRecoveryDatabases.add(databasePath);
      }
      return recovered;
    });
  const flight: RecoveryFlight = {
    promise: scan
      .finally(() => {
        if (recoveryFlights.get(databasePath) === flight) recoveryFlights.delete(databasePath);
      })
      .then(async (recovered) => {
        if (successfulRecoveryDatabases.has(databasePath)) return recovered;
        // An enqueue failure can invalidate this generation while its scan is still running. The
        // stale scan has now released SQLite and its flight slot, so immediately continue with the
        // current generation instead of making another foreground Run discover the gap. A failed
        // scan rejects before this continuation and therefore keeps the existing failure semantics.
        return recovered + (await recoverMemoryReviewJobs(input));
      }),
  };
  recoveryFlights.set(databasePath, flight);
  return flight.promise;
}

async function scanRuntimeLedger(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const store = new RuntimeEventStore({ databasePath: input.runtimeDatabasePath });
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

async function readCanonicalRecoveryRefs(
  store: RuntimeEventStore,
  sessionId: string,
): Promise<TerminalMemoryEvidenceRef[]> {
  // First pass discovers the only event IDs whose historical state a later rewind can request.
  // The second pass therefore snapshots state only at those targets rather than indexing every
  // event in a long Session.
  const { targets: rewindTargets, upperSequence } = await collectRewindTargets(store, sessionId);
  const projection = new CompactRecoveryProjection(sessionId, rewindTargets);
  let afterSequence = 0;
  while (afterSequence < upperSequence) {
    const entries = await store.readSessionEntriesPage(sessionId, {
      afterSequence,
      limit: RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
    });
    if (entries.length === 0) break;
    const boundedEntries = entries.filter((entry) => entry.sequence <= upperSequence);
    for (const entry of boundedEntries) projection.append(entry);
    if (boundedEntries.length === 0) break;
    afterSequence = boundedEntries.at(-1)!.sequence;
    await yieldToHost();
    if (afterSequence >= upperSequence || entries.length < RUNTIME_EVENT_STORE_MAX_PAGE_SIZE) {
      break;
    }
  }
  return projection.refs();
}

async function collectRewindTargets(
  store: RuntimeEventStore,
  sessionId: string,
): Promise<{ readonly targets: Set<string>; readonly upperSequence: number }> {
  const targets = new Set<string>();
  let afterSequence = 0;
  while (true) {
    const entries = await store.readSessionEntriesPage(sessionId, {
      afterSequence,
      limit: RUNTIME_EVENT_STORE_MAX_PAGE_SIZE,
    });
    if (entries.length === 0) break;
    for (const { event } of entries) {
      if (event.kind === "history.rewound" && event.data.throughEventId !== undefined) {
        targets.add(event.data.throughEventId);
      }
    }
    afterSequence = entries.at(-1)!.sequence;
    await yieldToHost();
    if (entries.length < RUNTIME_EVENT_STORE_MAX_PAGE_SIZE) break;
  }
  return { targets, upperSequence: afterSequence };
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

interface CompactProjectionState {
  readonly latestDesktopEvidence?: CompactEvidence;
  readonly runs: ReadonlyMap<string, CompactRunState>;
  readonly refsTail?: RecoveryRefNode;
}

/** Canonical rewind projection retaining only active runs, refs and requested rewind snapshots. */
class CompactRecoveryProjection {
  private latestDesktopEvidence: CompactEvidence | undefined;
  private runs = new Map<string, CompactRunState>();
  private refsTail: RecoveryRefNode | undefined;
  private readonly snapshots = new Map<string, CompactProjectionState>();

  constructor(
    private readonly sessionId: string,
    private readonly rewindTargets: ReadonlySet<string>,
  ) {}

  append(entry: RuntimeEventStoreEntry): void {
    const { event } = entry;
    if (event.kind === "history.rewound") {
      const throughEventId = event.data.throughEventId;
      if (throughEventId === undefined) {
        this.restore();
      } else {
        const snapshot = this.snapshots.get(throughEventId);
        if (!snapshot) {
          throw new Error(
            `Runtime recovery rewind ${event.eventId} references unknown event ${throughEventId}`,
          );
        }
        this.restore(snapshot);
      }
    } else if (event.kind === "run.started") {
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
        if (evidence && detectStableMemorySignal(evidence.content).eligible) {
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
      // A terminal Run can no longer receive canonical messages. Rewind snapshots retain only the
      // few pre-terminal states that are actually addressable by a future rewind.
      this.runs.delete(event.runId);
    }

    if (this.rewindTargets.has(event.eventId)) {
      if (this.snapshots.has(event.eventId)) {
        throw new Error(`Runtime recovery found duplicate event ID ${event.eventId}`);
      }
      this.snapshots.set(event.eventId, this.snapshot());
    }
  }

  refs(): TerminalMemoryEvidenceRef[] {
    const reversed: TerminalMemoryEvidenceRef[] = [];
    for (let node = this.refsTail; node; node = node.previous) reversed.push(node.ref);
    return reversed.reverse();
  }

  private snapshot(): CompactProjectionState {
    return {
      ...(this.latestDesktopEvidence ? { latestDesktopEvidence: this.latestDesktopEvidence } : {}),
      runs: new Map(this.runs),
      ...(this.refsTail ? { refsTail: this.refsTail } : {}),
    };
  }

  private restore(snapshot?: CompactProjectionState): void {
    this.latestDesktopEvidence = snapshot?.latestDesktopEvidence;
    this.runs = new Map(snapshot?.runs);
    this.refsTail = snapshot?.refsTail;
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
