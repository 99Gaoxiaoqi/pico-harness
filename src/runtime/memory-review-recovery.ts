import type { Message } from "../schema/message.js";
import type {
  RuntimeEventStoreEntry,
  RuntimeSessionManifest,
} from "../storage/runtime-event-store.js";
import { RuntimeEventStore } from "./runtime-event-store.js";
import { detectStableMemorySignal } from "../memory/proposal-signal.js";
import type { MemoryReviewSchedulerPort } from "../memory/runtime-scheduler.js";
import type { TerminalMemoryEvidenceRef } from "../memory/proposal-contracts.js";

export interface RecoverMemoryReviewJobsInput {
  readonly runtimeDatabasePath: string;
  readonly scheduler: MemoryReviewSchedulerPort;
}

/**
 * Replays canonical completed turns through the idempotent review scheduler. This closes the
 * crash window after run.terminal is durable but before the Memory job reaches its own database.
 */
export async function recoverMemoryReviewJobs(
  input: RecoverMemoryReviewJobsInput,
): Promise<number> {
  const store = new RuntimeEventStore({ databasePath: input.runtimeDatabasePath });
  let recovered = 0;
  try {
    for (const manifest of await store.listSessionManifests()) {
      const entries = await store.readSessionEntries(manifest.sessionId);
      for (const ref of findRecoverableMemoryReviewRefs(manifest, entries)) {
        await input.scheduler.enqueue(ref);
        recovered++;
      }
    }
  } finally {
    store.close();
  }
  return recovered;
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
  manifest: RuntimeSessionManifest,
  entries: readonly RuntimeEventStoreEntry[],
): TerminalMemoryEvidenceRef[] {
  const refs: TerminalMemoryEvidenceRef[] = [];
  for (const terminalEntry of entries) {
    const terminal = terminalEntry.event;
    if (
      terminal.kind !== "run.terminal" ||
      terminal.data.status !== "completed" ||
      terminal.data.recovered === true
    ) {
      continue;
    }
    const startedSequence = entries.find(
      (entry) => entry.event.kind === "run.started" && entry.event.runId === terminal.runId,
    )?.sequence;
    if (startedSequence === undefined) continue;

    const sameRunUser = entries.find(
      (entry) =>
        entry.sequence > startedSequence &&
        entry.sequence < terminalEntry.sequence &&
        entry.event.runId === terminal.runId &&
        isModelUserMessage(entry) &&
        entry.event.kind === "message.committed" &&
        entry.event.data.message.providerData?.["picoKind"] === undefined &&
        entry.event.data.message.providerData?.["picoHiddenFromTranscript"] !== true,
    );
    let evidence =
      sameRunUser?.event.kind === "message.committed"
        ? {
            eventId: sameRunUser.event.eventId,
            content: sameRunUser.event.data.message.content,
          }
        : undefined;

    if (!evidence) {
      const latestModelMessage = entries.findLast(
        (entry) => entry.sequence < startedSequence && isModelMessage(entry),
      );
      if (latestModelMessage?.event.kind === "message.committed") {
        const content = strictDesktopInputText(latestModelMessage.event.data.message);
        if (content) evidence = { eventId: latestModelMessage.event.eventId, content };
      }
    }
    if (!evidence || !detectStableMemorySignal(evidence.content).eligible) continue;
    refs.push({
      sessionId: manifest.sessionId,
      runId: terminal.runId,
      terminalEventId: terminal.eventId,
      userMessageEventId: evidence.eventId,
      terminalSequence: terminalEntry.sequence,
    });
  }
  return refs;
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
