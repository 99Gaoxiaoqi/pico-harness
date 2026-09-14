import type { DurableTranscriptEvent } from "./durable-transcript-contract.js";
import type { Message } from "./message.js";
import type { SessionIdentity } from "./session-identity.js";
import type { SessionRuntimeStateSnapshot } from "./session-runtime-state.js";
import type { ToolResultEnvelope } from "./tool-result.js";

/** Consistent durable snapshot used to hydrate a session-facing entrypoint. */
export interface SessionHydrationSnapshot {
  schemaVersion: 1;
  /** Last RuntimeEvent sequence represented by this snapshot, or null without persistence. */
  persistenceSequence: number | null;
  sessionId: string;
  conversationId: string;
  workDir: string;
  identity: SessionIdentity;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  /** Effective message positions in the canonical RuntimeEvent sequence. */
  messageSequences: readonly number[];
  /** Durable, presentation-independent transcript facts in RuntimeEvent order. */
  transcriptEvents: readonly DurableTranscriptEvent[];
  /** RuntimeEvent sequence for each transcript event, aligned by index. */
  transcriptEventSequences: readonly number[];
  /** Active-branch ToolResult facts reduced to the bounded host envelope. */
  toolResults: readonly SessionHydrationToolResult[];
  runtime: SessionRuntimeStateSnapshot;
}

export interface SessionHydrationToolResult {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}
