export type AgentGraphDiagnosticClassification =
  | "transient"
  | "configuration"
  | "integrity";

export type AgentGraphDiagnosticState = "retry_scheduled" | "needs_attention" | "resolved";

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_024;

/** Explicit marker for failures that retrying cannot safely repair by itself. */
export class AgentGraphNeedsAttentionError extends Error {
  constructor(
    readonly classification: Exclude<AgentGraphDiagnosticClassification, "transient">,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentGraphNeedsAttentionError";
  }
}

/** Bounds and redacts operational errors before they enter the Graph control ledger. */
export function safeAgentGraphErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutUnsafeControls = [...raw]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
        codePoint === 127
        ? " "
        : character;
    })
    .join("");
  return withoutUnsafeControls
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .replace(/\b(sk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "<redacted>")
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/giu, "$1<redacted>@")
    .replace(
      /\b[A-Za-z0-9_]*(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1=<redacted>",
    )
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
    .trim() || "Agent Graph operation failed";
}

export function classifyAgentGraphError(
  error: unknown,
): AgentGraphDiagnosticClassification {
  if (error instanceof AgentGraphNeedsAttentionError) return error.classification;
  if (error instanceof Error && error.name === "AgentGraphStoreConflictError") {
    return "integrity";
  }
  return "transient";
}
