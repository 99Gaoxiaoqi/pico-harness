/** An audit limit, not a truncation policy: oversized calls must never cross T1. */
export const MAX_TOOL_ARGUMENT_AUDIT_BYTES = 1024 * 1024;
const REDACTED = "[REDACTED]";

function sensitiveField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /^(?:password|passwd|pwd|secret|token|authorization|proxyauthorization|cookie|setcookie|credential|credentials|apikey|privatekey|clientsecret|accesskey|secretaccesskey|sessionkey|accesstoken|refreshtoken|authtoken|bearertoken)$/.test(
    normalized,
  );
}

/** Redact a separate JSON audit; the caller retains the untouched execution arguments. */
export function buildToolArgumentAudit(
  argumentsJson: string,
  redactionSecrets: readonly string[] = [],
): { argumentsJson: string; argumentsRedacted: boolean } {
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_TOOL_ARGUMENT_AUDIT_BYTES) {
    throw new Error("Tool arguments exceed the 1 MiB durable audit limit");
  }
  const secrets = [...new Set(redactionSecrets)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let redacted = false;
  const redactLiteral = (value: string): string => {
    let output = value;
    for (const secret of secrets) output = output.replaceAll(secret, REDACTED);
    if (output !== value) redacted = true;
    return output;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 128) throw new Error("Tool arguments exceed the durable audit nesting limit");
    if (typeof value === "string") {
      // Tools may carry JSON inside a string (e.g. request bodies). Inspect it
      // before literal replacement so escaped secrets and sensitive keys survive decoding.
      let embedded: unknown;
      try {
        embedded = JSON.parse(value);
      } catch {
        return redactLiteral(value);
      }
      if ((typeof embedded === "object" && embedded !== null) || typeof embedded === "string") {
        const transformed = visit(embedded, depth + 1);
        if (JSON.stringify(transformed) !== JSON.stringify(embedded)) {
          redacted = true;
          return redactLiteral(JSON.stringify(transformed));
        }
      }
      return redactLiteral(value);
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => {
          if (sensitiveField(key)) {
            if (entry !== REDACTED) redacted = true;
            return [redactLiteral(key), REDACTED];
          }
          return [redactLiteral(key), visit(entry, depth + 1)];
        }),
      );
    }
    return value;
  };
  const audited = visit(JSON.parse(argumentsJson), 0);
  const auditJson = redacted ? JSON.stringify(audited) : argumentsJson;
  if (Buffer.byteLength(auditJson, "utf8") > MAX_TOOL_ARGUMENT_AUDIT_BYTES) {
    throw new Error("Redacted tool arguments exceed the 1 MiB durable audit limit");
  }
  return { argumentsJson: auditJson, argumentsRedacted: redacted };
}
