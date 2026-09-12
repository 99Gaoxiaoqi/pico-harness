// Shared JSON, identifiers, modes, and wire version constants; no domain dependencies.

export const LOCAL_RUNTIME_PROTOCOL_VERSION = 2;

export const LOCAL_RUNTIME_AUTH_VERSION = 1;

/** Increment when the Desktop-required result schema changes incompatibly. */
export const DESKTOP_RUNTIME_SCHEMA_REVISION = 16;

export const DESKTOP_RUNTIME_SCHEMA_CAPABILITY = "desktop-runtime-schema-v16";

export const CAPABILITY_SCOPE_RUNTIME_CAPABILITY = "capability-scopes-v1";

export const TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY = "temporary-workspace-v1";

export const MAX_RUNTIME_FRAME_BYTES = 1024 * 1024;

/** Maximum UTF-8 payload exposed through a host-facing ToolResult projection. */
export const MAX_TOOL_RESULT_ENVELOPE_TEXT_BYTES = 16 * 1024;

export const EPHEMERAL_RUNTIME_NOTIFICATION_TOPICS = [] as const;

export type JsonScalar = boolean | null | number | string;

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = JsonScalar | readonly JsonValue[] | JsonObject;

declare const identifierBrand: unique symbol;

export type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]?: Kind;
};

export type SessionId = Identifier<"SessionId">;

export type RunId = Identifier<"RunId">;

export type JobId = Identifier<"JobId">;

export type ApprovalId = Identifier<"ApprovalId">;

export type PlanId = Identifier<"PlanId">;

export type PromptId = Identifier<"PromptId">;

export type CheckpointId = Identifier<"CheckpointId">;

export type EmptyParams = Record<string, never>;

export type WorkspaceParams = { readonly workspacePath: string };

export type WorkspaceRegistrationParams = WorkspaceParams;

export type RuntimeRunStatus =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "succeeded";

export type RuntimeSessionStatus = "active" | "archived";

export type RuntimeRewindMode = "code" | "conversation" | "both";

export type RuntimeJobStatus = "idle" | "running" | "failed" | "succeeded";

export type SessionSendBehavior = "auto" | "steer" | "queue" | "replace";

export type SessionSendDisposition = "started" | "steered" | "queued" | "replaced";

export type RuntimeCollaborationMode = "agent" | "plan";

export type RuntimeOrchestrationMode = "default" | "graph" | "swarm";

export type RuntimePermissionMode = "ask" | "auto" | "full-access";

/** @deprecated Compatibility input accepted by older clients. */
export type RuntimeInteractionMode = RuntimePermissionMode | "plan";

export type RuntimeProviderKind = "openai" | "claude" | "responses";

export type RuntimeConfigSource =
  | "user"
  | "project"
  | "project-legacy"
  | "environment"
  | "session"
  | "cli";

export type RuntimeCredentialStatus = "ready" | "missing" | "environment" | "unsupported";

export type RuntimeCredentialSource = "config" | "keychain" | "environment" | "none";

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function optionalStringField(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

export function isJsonObject(value: JsonValue): value is JsonObject;

export function isJsonObject(value: unknown): value is Record<string, unknown>;

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}
