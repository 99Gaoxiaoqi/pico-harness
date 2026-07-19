import type {
  RunId,
  RuntimeRunStatus,
  RuntimeSessionStatus,
  SessionId,
  SessionSendDisposition,
} from "./runtime.js";

export const MOBILE_GATEWAY_PROTOCOL_VERSION = 1;
export const MAX_MOBILE_MESSAGE_BYTES = 32 * 1024;
export const MAX_MOBILE_IDEMPOTENCY_KEY_LENGTH = 128;

declare const mobileProjectIdBrand: unique symbol;
export type MobileProjectId = string & {
  readonly [mobileProjectIdBrand]?: "MobileProjectId";
};

export interface MobileProject {
  readonly projectId: MobileProjectId;
  readonly name: string;
}

export interface MobileSession {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly status: RuntimeSessionStatus;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MobileRun {
  readonly runId: RunId;
  readonly sessionId?: SessionId;
  readonly description: string;
  readonly status: RuntimeRunStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
}

interface MobileConversationItemBase {
  readonly id: string;
  readonly at?: number;
  readonly truncated?: true;
  readonly originalBytes?: number;
}

export type MobileConversationItem = MobileConversationItemBase &
  (
    | {
        readonly kind: "userMessage" | "systemNotice" | "error";
        readonly content: string;
      }
    | {
        readonly kind: "assistantMessage" | "thinking";
        readonly content: string;
        readonly runId?: RunId;
        readonly turnId?: string;
      }
    | {
        readonly kind: "skill";
        readonly name: string;
        readonly args: string;
        readonly trigger: "user-slash" | "model-tool";
      }
    | {
        readonly kind: "plan";
        readonly title: string;
        readonly detail?: string;
        readonly state?: "waiting" | "active" | "done" | "failed";
      }
    | {
        readonly kind: "tool";
        readonly name: string;
        readonly args: string;
        readonly status: "running" | "success" | "error";
        readonly summary?: string;
      }
    | {
        readonly kind: "runBoundary";
        readonly runId?: RunId;
        readonly status: RuntimeRunStatus;
        readonly startedAt: number;
        readonly finishedAt?: number;
        readonly error?: string;
      }
    | {
        readonly kind: "approval" | "prompt" | "changes" | "goal";
        readonly title: string;
        readonly detail?: string;
        readonly state?: string;
      }
    | {
        readonly kind: "subagent";
        readonly name?: string;
        readonly title: string;
        readonly detail?: string;
        readonly state?: string;
      }
  );

export interface MobileTranscript {
  readonly session: MobileSession;
  readonly items: readonly MobileConversationItem[];
  readonly activeRun?: MobileRun;
  readonly nextBefore?: string;
  readonly revision: string;
}

export interface MobileGatewayRouteMap {
  readonly "GET /v1/projects": {
    readonly params: Record<string, never>;
    readonly result: { readonly projects: readonly MobileProject[] };
  };
  readonly "GET /v1/projects/:projectId/sessions": {
    readonly params: { readonly projectId: MobileProjectId };
    readonly result: { readonly sessions: readonly MobileSession[] };
  };
  readonly "GET /v1/projects/:projectId/sessions/:sessionId/transcript": {
    readonly params: {
      readonly projectId: MobileProjectId;
      readonly sessionId: SessionId;
      readonly before?: string;
    };
    readonly result: MobileTranscript;
  };
  readonly "POST /v1/projects/:projectId/messages": {
    readonly params: {
      readonly projectId: MobileProjectId;
      readonly body: MobileSendMessageBody;
    };
    readonly result: {
      readonly session: MobileSession;
      readonly run?: MobileRun;
      readonly disposition: SessionSendDisposition;
    };
  };
}

export interface MobileSendMessageBody {
  readonly sessionId?: SessionId;
  readonly text: string;
  readonly idempotencyKey: string;
}

/**
 * Validates the only write payload exposed by the first Mobile Gateway version.
 * Keeping this parser strict prevents callers from smuggling Runtime-only fields
 * such as workspacePath, behavior, Skill input, or Agent activation.
 */
export function parseMobileSendMessageBody(value: unknown): MobileSendMessageBody {
  if (!isRecord(value)) throw new Error("Mobile message body must be an object");
  assertOnlyKeys(value, ["sessionId", "text", "idempotencyKey"]);

  const text = requireString(value["text"], "text");
  if (!text.trim()) throw new Error("Mobile message text must not be empty");
  if (utf8ByteLength(text) > MAX_MOBILE_MESSAGE_BYTES) {
    throw new Error(`Mobile message text exceeds ${MAX_MOBILE_MESSAGE_BYTES} bytes`);
  }

  const idempotencyKey = requireString(value["idempotencyKey"], "idempotencyKey");
  if (!idempotencyKey.trim()) throw new Error("Mobile idempotencyKey must not be empty");
  if (idempotencyKey.length > MAX_MOBILE_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(
      `Mobile idempotencyKey exceeds ${MAX_MOBILE_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }

  const sessionId = value["sessionId"];
  if (sessionId === undefined) return { text, idempotencyKey };
  return {
    sessionId: requireString(sessionId, "sessionId") as SessionId,
    text,
    idempotencyKey,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Mobile message body contains unsupported field: ${unexpected}`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Mobile ${field} must be a string`);
  return value;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
