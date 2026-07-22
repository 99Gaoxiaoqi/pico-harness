import { createHash } from "node:crypto";
import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { isMessageHiddenFromTranscript } from "../schema/message.js";
import type {
  MemoryEvidenceReaderPort,
  TerminalMemoryEvidenceRef,
  UserMemoryEvidence,
} from "./proposal-contracts.js";

export interface RuntimeEvidenceStorePort {
  readSessionEvent(sessionId: string, eventId: string): Promise<RuntimeEventStoreEntry | undefined>;
}

export class MemoryEvidenceError extends Error {
  constructor(readonly code: string) {
    super(`Memory evidence is invalid: ${code}`);
    this.name = "MemoryEvidenceError";
  }
}

/** Reads exact runtime facts and rejects assistant, tool and synthetic user messages. */
export class RuntimeMemoryEvidenceReader implements MemoryEvidenceReaderPort {
  constructor(private readonly store: RuntimeEvidenceStorePort) {}

  async read(ref: TerminalMemoryEvidenceRef): Promise<UserMemoryEvidence> {
    const [terminalEntry, userEntry] = await Promise.all([
      this.store.readSessionEvent(ref.sessionId, ref.terminalEventId),
      this.store.readSessionEvent(ref.sessionId, ref.userMessageEventId),
    ]);
    if (!terminalEntry) throw new MemoryEvidenceError("terminal_missing");
    if (!userEntry) throw new MemoryEvidenceError("user_message_missing");
    assertTerminal(terminalEntry.event, ref);
    const content = assertUserMessage(
      userEntry.event,
      ref,
      userEntry.sequence,
      terminalEntry.sequence,
    );
    const digestPayload = JSON.stringify({
      sessionId: ref.sessionId,
      runId: ref.runId,
      terminalEventId: ref.terminalEventId,
      userMessageEventId: ref.userMessageEventId,
      userSequence: userEntry.sequence,
      content,
    });
    const digestHex = createHash("sha256").update(digestPayload).digest("hex");
    return {
      ...ref,
      content,
      eventIds: [ref.userMessageEventId],
      startSequence: userEntry.sequence,
      endSequence: userEntry.sequence,
      terminalSequence: terminalEntry.sequence,
      digest: `sha256:${digestHex}`,
      sourceId: `source:${digestHex}`,
      cursor: {
        sessionId: ref.sessionId,
        sequence: terminalEntry.sequence,
        eventId: ref.terminalEventId,
      },
    };
  }
}

function assertTerminal(event: RuntimeEvent, ref: TerminalMemoryEvidenceRef): void {
  if (
    event.eventId !== ref.terminalEventId ||
    event.sessionId !== ref.sessionId ||
    event.runId !== ref.runId ||
    event.kind !== "run.terminal" ||
    event.data.status !== "completed" ||
    event.data.recovered === true ||
    event.visibility !== "internal" ||
    event.partial
  ) {
    throw new MemoryEvidenceError("terminal_not_completed");
  }
}

function assertUserMessage(
  event: RuntimeEvent,
  ref: TerminalMemoryEvidenceRef,
  userSequence: number,
  terminalSequence: number,
): string {
  if (
    event.eventId !== ref.userMessageEventId ||
    event.sessionId !== ref.sessionId ||
    event.kind !== "message.committed" ||
    event.visibility !== "model" ||
    event.partial
  ) {
    throw new MemoryEvidenceError("user_message_identity");
  }
  const message = event.data.message;
  if (
    message.role !== "user" ||
    message.toolCallId !== undefined ||
    isMessageHiddenFromTranscript(message)
  ) {
    throw new MemoryEvidenceError("not_user_authored");
  }
  const desktopDisplayText = message.providerData?.["displayText"];
  const isVerifiedPrecommittedDesktopInput =
    message.providerData?.["picoKind"] === "desktop_user_input" &&
    typeof desktopDisplayText === "string" &&
    desktopDisplayText.trim().length > 0 &&
    message.content === desktopDisplayText &&
    userSequence < terminalSequence;
  if (event.runId !== ref.runId && !isVerifiedPrecommittedDesktopInput) {
    throw new MemoryEvidenceError("user_message_identity");
  }
  const content = message.content.normalize("NFKC").trim();
  if (!content) throw new MemoryEvidenceError("user_message_empty");
  return content;
}
