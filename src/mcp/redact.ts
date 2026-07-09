const SENSITIVE_KEY_PATTERN = /^(?:.*(?:api[-_]?key|apikey|token|authorization|password|passwd|secret).*)$/i;

export function redactSensitiveText(text: string): string {
  return text
    .replace(
      /((?:authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/((?:authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_]?key|apikey|token|password|passwd|secret)\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:api[-_]?key|apikey|token|authorization|password|passwd|secret)"\s*:\s*")[^"]+"/gi,
      "$1[REDACTED]\"",
    );
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (typeof value !== "object" || value === null) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactSensitiveValue(nestedValue);
  }
  return redacted;
}
