const SENSITIVE_KEY_PATTERN =
  /^(?:.*(?:api[-_]?key|apikey|token|authorization|password|passwd|secret).*)$/i;
const SENSITIVE_ARG_FLAG_RE =
  /^--?(?:api[-_]?key|apikey|token|authorization|password|passwd|secret)$/iu;

export function redactSensitiveText(text: string): string {
  return text
    .replace(/((?:authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_]?key|apikey|token|password|passwd|secret)\s*[:=]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:api[-_]?key|apikey|token|authorization|password|passwd|secret)"\s*:\s*")[^"]+"/gi,
      '$1[REDACTED]"',
    );
}

/**
 * 对 argv 保留位置地脱敏。单独处理每个参数无法识别
 * `--token SECRET` 这种“标志 + 下一个参数”形式。
 */
export function redactSensitiveArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (SENSITIVE_ARG_FLAG_RE.test(arg)) {
      redacted.push(redactSensitiveText(arg));
      redactNext = true;
      continue;
    }
    redacted.push(redactSensitiveText(arg));
  }
  return redacted;
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
