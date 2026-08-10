import { createHash } from "node:crypto";
import type { RuntimeEvent } from "../engine/session-runtime-event.js";
import { isRuntimeMessageEvent } from "../engine/session-runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { isMessageHiddenFromTranscript, type Message } from "../schema/message.js";
import {
  EVIDENCE_REF_SCHEMA_VERSION,
  validateEvidenceRef,
  type EvidenceRef,
} from "../engine/evidence-ref.js";
import type {
  MemoryEvidenceReaderPort,
  TerminalMemoryEvidenceRef,
  UserMemoryEvidence,
} from "./proposal-contracts.js";

export interface RuntimeEvidenceStorePort {
  readSessionEvent(sessionId: string, eventId: string): Promise<RuntimeEventStoreEntry | undefined>;
  readSessionEntries?(sessionId: string): Promise<readonly RuntimeEventStoreEntry[]>;
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
    // 读取源对话消息快照（截止 terminal sequence），让提取模型看到完整上下文。
    let sourceMessages: readonly Message[] | undefined;
    if (this.store.readSessionEntries) {
      try {
        const entries = await this.store.readSessionEntries(ref.sessionId);
        sourceMessages = entries
          .filter((e) => e.sequence <= terminalEntry.sequence && isRuntimeMessageEvent(e.event))
          .map((e) => (e.event as { data: { message: Message } }).data.message)
          .filter((m) => !isMessageHiddenFromTranscript(m));
      } catch {
        // 读取失败不阻断提取，回退到无 sourceMessages 的独立请求。
      }
    }
    // 构造统一溯源 overlay：把离散 eventId 升级为带流身份的区间 cursor。
    // sequence 是 session 级全局 append 序号（runtime-event-store.ts:496），
    // 故 streamId 绑定到 sessionId（而非 runId）以对齐序号语义。
    const evidenceRefCandidate: EvidenceRef = {
      schemaVersion: EVIDENCE_REF_SCHEMA_VERSION,
      sessionId: ref.sessionId,
      runId: ref.runId,
      coverage: {
        ledger: "session_runtime_event",
        streamId: ref.sessionId,
        lowSequence: userEntry.sequence,
        highSequence: userEntry.sequence,
        eventIds: [ref.userMessageEventId],
        eventCount: 1,
      },
      digest: `sha256:${digestHex}`,
    };
    // overlay 校验失败时静默降级（不阻断提取），但正常路径下应总是有效。
    const evidenceRefValidation = validateEvidenceRef(evidenceRefCandidate);
    const evidenceRef = evidenceRefValidation.ok ? evidenceRefCandidate : undefined;
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
      ...(evidenceRef ? { evidenceRef } : {}),
      ...(sourceMessages ? { sourceMessages } : {}),
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
