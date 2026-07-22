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
const successfulRecoveryDatabases = new Set<string>();
const recoveryFlights = new Map<string, Promise<number>>();

/**
 * Replays canonical completed turns through the idempotent review scheduler. This closes the
 * crash window after run.terminal is durable but before the Memory job reaches its own database.
 */
export function recoverMemoryReviewJobs(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const databasePath = resolve(input.runtimeDatabasePath);
  if (successfulRecoveryDatabases.has(databasePath)) return Promise.resolve(0);
  const inFlight = recoveryFlights.get(databasePath);
  if (inFlight) return inFlight;

  // Begin in a later host task so opening SQLite never extends the caller's synchronous path.
  const attempt = yieldToHost()
    .then(() => scanRuntimeLedger({ ...input, runtimeDatabasePath: databasePath }))
    .then((recovered) => {
      successfulRecoveryDatabases.add(databasePath);
      return recovered;
    })
    .finally(() => {
      if (recoveryFlights.get(databasePath) === attempt) recoveryFlights.delete(databasePath);
    });
  recoveryFlights.set(databasePath, attempt);
  return attempt;
}

async function scanRuntimeLedger(input: RecoverMemoryReviewJobsInput): Promise<number> {
  const store = new RuntimeEventStore({ databasePath: input.runtimeDatabasePath });
  let recovered = 0;
  try {
    let manifestOffset = 0;
    while (true) {
      const manifests = await store.listSessionManifestsPage({
        offset: manifestOffset,
        limit: RECOVERY_SESSION_PAGE_SIZE,
      });
      if (manifests.length === 0) break;
      for (const manifest of manifests) {
        const activeEntries = await readCanonicalRecoveryEntries(store, manifest.sessionId);
        for (const ref of findRecoverableMemoryReviewRefs(manifest.sessionId, activeEntries)) {
          await input.scheduler.enqueue(ref);
          recovered++;
        }
      }
      manifestOffset += manifests.length;
      await yieldToHost();
      if (manifests.length < RECOVERY_SESSION_PAGE_SIZE) break;
    }
  } finally {
    store.close();
  }
  return recovered;
}

async function readCanonicalRecoveryEntries(
  store: RuntimeEventStore,
  sessionId: string,
): Promise<RuntimeEventStoreEntry[]> {
  const projection = new CanonicalRecoveryProjection();
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
  return projection.entries();
}

interface RecoveryProjectionNode {
  readonly entry: RuntimeEventStoreEntry;
  readonly previous?: RecoveryProjectionNode;
}

/** Streaming equivalent of materializing the canonical prefix after every rewind. */
class CanonicalRecoveryProjection {
  private tail: RecoveryProjectionNode | undefined;
  private readonly tailByEventId = new Map<string, RecoveryProjectionNode | undefined>();

  append(entry: RuntimeEventStoreEntry): void {
    const { event } = entry;
    if (this.tailByEventId.has(event.eventId)) {
      throw new Error(`Runtime recovery found duplicate event ID ${event.eventId}`);
    }
    if (event.kind === "history.rewound") {
      const throughEventId = event.data.throughEventId;
      if (throughEventId === undefined) {
        this.tail = undefined;
      } else {
        if (!this.tailByEventId.has(throughEventId)) {
          throw new Error(
            `Runtime recovery rewind ${event.eventId} references unknown event ${throughEventId}`,
          );
        }
        this.tail = this.tailByEventId.get(throughEventId);
      }
    } else if (isRecoveryRelevant(entry)) {
      this.tail = { entry, ...(this.tail ? { previous: this.tail } : {}) };
    }
    this.tailByEventId.set(event.eventId, this.tail);
  }

  entries(): RuntimeEventStoreEntry[] {
    const reversed: RuntimeEventStoreEntry[] = [];
    for (let node = this.tail; node; node = node.previous) reversed.push(node.entry);
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

function findRecoverableMemoryReviewRefs(
  sessionId: string,
  entries: readonly RuntimeEventStoreEntry[],
): TerminalMemoryEvidenceRef[] {
  const refs: TerminalMemoryEvidenceRef[] = [];
  let latestModelMessage: RuntimeEventStoreEntry | undefined;
  const runs = new Map<
    string,
    {
      readonly priorModelMessage?: RuntimeEventStoreEntry;
      directUser?: { readonly eventId: string; readonly content: string };
      hasAssistantResponse?: boolean;
    }
  >();
  for (const entry of entries) {
    const event = entry.event;
    if (event.kind === "run.started") {
      runs.set(event.runId, {
        ...(latestModelMessage ? { priorModelMessage: latestModelMessage } : {}),
      });
      continue;
    }
    if (isModelMessage(entry) && event.kind === "message.committed") {
      const run = runs.get(event.runId);
      if (
        run &&
        !run.directUser &&
        isModelUserMessage(entry) &&
        event.data.message.providerData?.["picoKind"] === undefined &&
        event.data.message.providerData?.["picoHiddenFromTranscript"] !== true
      ) {
        run.directUser = { eventId: event.eventId, content: event.data.message.content };
      }
      if (run && event.data.message.role === "assistant") run.hasAssistantResponse = true;
      latestModelMessage = entry;
      continue;
    }
    if (
      event.kind !== "run.terminal" ||
      event.data.status !== "completed" ||
      event.data.recovered === true
    ) {
      continue;
    }
    const run = runs.get(event.runId);
    if (!run) continue;
    if (!run.hasAssistantResponse) continue;
    let evidence = run.directUser;
    if (!evidence && run.priorModelMessage?.event.kind === "message.committed") {
      const content = strictDesktopInputText(run.priorModelMessage.event.data.message);
      if (content) evidence = { eventId: run.priorModelMessage.event.eventId, content };
    }
    if (!evidence || !detectStableMemorySignal(evidence.content).eligible) continue;
    refs.push({
      sessionId,
      runId: event.runId,
      terminalEventId: event.eventId,
      userMessageEventId: evidence.eventId,
      terminalSequence: entry.sequence,
    });
  }
  return refs;
}

function isRecoveryRelevant(entry: RuntimeEventStoreEntry): boolean {
  return (
    entry.event.kind === "run.started" ||
    entry.event.kind === "run.terminal" ||
    isModelMessage(entry)
  );
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
