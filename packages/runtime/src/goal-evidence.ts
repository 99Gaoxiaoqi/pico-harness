import type {
  ForegroundProcessFacts,
  GoalEvidenceIdentity,
  GoalEvidenceTrace,
  RuntimeToolResultStatus,
} from "@pico/core";
export type { GoalEvidenceIdentity, GoalEvidenceReference, GoalEvidenceTrace } from "@pico/core";
import { createHash } from "node:crypto";

export const GOAL_EVIDENCE_MAX_TOOLS = 12;
export const GOAL_EVIDENCE_MAX_MESSAGES = 6;
export const GOAL_EVIDENCE_MAX_INPUT_BYTES = 24 * 1024;
export const GOAL_EVIDENCE_MAX_INPUT_TOKENS = 4_096;

export interface GoalEvidenceRunAnchor {
  readonly eventId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly invocationId: string;
  readonly status?: string;
}

/** Narrow read DTO: excerpts are never represented as canonical, hash-validated events. */
export interface GoalEvidenceTool {
  readonly eventId: string;
  readonly sequence: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: RuntimeToolResultStatus;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly excerpt: string;
  readonly truncated: boolean;
  readonly projectionMode: "full" | "preview" | "synthetic";
  readonly executionFacts?: ForegroundProcessFacts;
  readonly recoveryClassification?: "indeterminate" | "not_dispatched";
  readonly start?: {
    readonly eventId: string;
    readonly sequence: number;
    readonly argumentsJson: string;
    readonly argumentsTruncated: boolean;
  };
}

export interface GoalEvidenceMessage {
  readonly eventId: string;
  readonly sequence: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export interface GoalEvidenceRunSlice {
  readonly throughSequence: number;
  readonly identity: {
    readonly started?: GoalEvidenceRunAnchor;
    readonly terminal?: GoalEvidenceRunAnchor;
  };
  readonly tools: readonly GoalEvidenceTool[];
  readonly messages: readonly GoalEvidenceMessage[];
  readonly finalReply?: GoalEvidenceMessage;
  readonly toolResultCount: number;
  readonly messageCount: number;
  readonly incompleteToolCallCount: number;
  readonly latestPotentialMutationSequence?: number;
  readonly potentialMutationCount: number;
  readonly potentialMutations: readonly {
    readonly eventId: string;
    readonly sequence: number;
    readonly toolName: string;
  }[];
}

export interface GoalEvidenceContext {
  readonly identity: GoalEvidenceIdentity;
  readonly coverage: GoalEvidenceTrace["coverage"];
  readonly tools: readonly GoalEvidenceTool[];
  readonly messages: readonly GoalEvidenceMessage[];
  readonly finalReplyEventId?: string;
  readonly finalReply?: GoalEvidenceMessage;
  readonly incompleteToolCallCount: number;
  readonly latestPotentialMutationSequence?: number;
  readonly potentialMutations: GoalEvidenceRunSlice["potentialMutations"];
  readonly potentialMutationCount: number;
  readonly unavailableReason?: string;
}

export function buildGoalEvidenceContext(
  identity: Omit<GoalEvidenceIdentity, "terminalEventId" | "throughSequence">,
  slice: GoalEvidenceRunSlice,
): GoalEvidenceContext {
  const { started, terminal } = slice.identity;
  const anchors = [started, terminal];
  const matches = anchors.every(
    (anchor) =>
      anchor &&
      anchor.sessionId === identity.sessionId &&
      anchor.runId === identity.runId &&
      anchor.invocationId === identity.invocationId,
  );
  const validBoundary =
    matches &&
    started?.eventId === identity.runStartedEventId &&
    started.turnId === identity.turnId &&
    terminal?.status === "completed" &&
    started.sequence < terminal.sequence &&
    terminal.sequence <= slice.throughSequence;
  const terminalSequence = terminal?.sequence ?? 0;
  const tools = validBoundary
    ? slice.tools
        .filter((tool) => tool.sequence <= terminalSequence)
        .slice(-GOAL_EVIDENCE_MAX_TOOLS)
        .map((tool) => ({
          ...structuredClone(tool),
          excerpt: boundedEvidenceText(tool.excerpt, 1_024),
          truncated: tool.truncated || Buffer.byteLength(tool.excerpt, "utf8") > 1_024,
          ...(tool.start
            ? {
                start: {
                  ...tool.start,
                  argumentsJson: boundedEvidenceText(tool.start.argumentsJson, 512),
                  argumentsTruncated:
                    tool.start.argumentsTruncated ||
                    Buffer.byteLength(tool.start.argumentsJson, "utf8") > 512,
                },
              }
            : {}),
        }))
    : [];
  const messages = validBoundary
    ? slice.messages
        .filter((message) => message.sequence <= terminalSequence)
        .slice(-GOAL_EVIDENCE_MAX_MESSAGES)
        .map((message) => {
          const content = boundedEvidenceText(message.content.slice(0, 500), 1_500);
          return {
            ...message,
            content,
            truncated: message.truncated || content !== message.content,
          };
        })
    : [];
  const rawFinalReply = validBoundary
    ? (slice.finalReply ?? messages.filter((message) => message.role === "assistant").at(-1))
    : undefined;
  const finalReply = rawFinalReply
    ? {
        ...rawFinalReply,
        content: boundedEvidenceText(rawFinalReply.content.slice(0, 500), 1_500),
        truncated:
          rawFinalReply.truncated ||
          boundedEvidenceText(rawFinalReply.content.slice(0, 500), 1_500) !== rawFinalReply.content,
      }
    : undefined;
  const limited =
    tools.length < slice.toolResultCount ||
    messages.length < slice.messageCount ||
    tools.some((tool) => tool.truncated || tool.start?.argumentsTruncated) ||
    messages.some((message) => message.truncated);
  return Object.freeze({
    identity: Object.freeze({
      ...identity,
      terminalEventId: terminal?.eventId ?? "",
      throughSequence: slice.throughSequence,
    }),
    coverage: !validBoundary ? "unavailable" : limited ? "limited" : "complete",
    tools: Object.freeze(tools),
    messages: Object.freeze(messages),
    ...(finalReply ? { finalReplyEventId: finalReply.eventId, finalReply } : {}),
    incompleteToolCallCount: slice.incompleteToolCallCount,
    ...(slice.latestPotentialMutationSequence !== undefined
      ? { latestPotentialMutationSequence: slice.latestPotentialMutationSequence }
      : {}),
    potentialMutations: Object.freeze(slice.potentialMutations.slice(-12)),
    potentialMutationCount: slice.potentialMutationCount,
    ...(!validBoundary ? { unavailableReason: "当前 Run 的起点、终点或身份不匹配" } : {}),
  });
}

export function goalEvidenceTrace(
  context: GoalEvidenceContext,
  citedEvidenceIds: readonly string[] = [],
  gateReason?: string,
): GoalEvidenceTrace {
  return {
    version: 1,
    traceId: `goal-evaluation:${createHash("sha256").update(JSON.stringify(context.identity)).digest("hex")}`,
    sourceRunId: context.identity.runId,
    identity: structuredClone(context.identity),
    coverage: context.coverage,
    providedEvidence: [
      ...context.tools.map((tool) => ({
        eventId: tool.eventId,
        kind: "tool" as const,
        toolCallId: tool.toolCallId,
        sha256: tool.sha256,
        sizeBytes: tool.sizeBytes,
        status: tool.status,
        truncated: tool.truncated,
      })),
      ...[...context.messages, ...(context.finalReply ? [context.finalReply] : [])]
        .filter(
          (message, index, items) =>
            items.findIndex((item) => item.eventId === message.eventId) === index,
        )
        .map((message) => ({
          eventId: message.eventId,
          kind: "message" as const,
          sha256: message.sha256,
          sizeBytes: message.sizeBytes,
          truncated: message.truncated,
        })),
    ],
    citedEvidenceIds: [...citedEvidenceIds],
    ...(gateReason ? { gateReason: boundedEvidenceText(gateReason, 600) } : {}),
  };
}

export function boundedEvidenceText(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const symbol of value) {
    const size = Buffer.byteLength(symbol, "utf8");
    if (bytes + size > maxBytes) break;
    result += symbol;
    bytes += size;
  }
  return result;
}
