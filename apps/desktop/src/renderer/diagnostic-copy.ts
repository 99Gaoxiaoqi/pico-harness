import { copyText } from "./clipboard.js";

const sensitiveKey =
  /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|apikey|(?:access[-_]?|refresh[-_]?)?token|password|passwd|secret|client[-_]?secret)$/i;

/** Only the explicit diagnostic export path uses this; local records stay unchanged. */
export function redactDiagnostic(value: string): string {
  try {
    return JSON.stringify(redactValue(JSON.parse(value)), null, 2);
  } catch {
    return redactText(value);
  }
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? "[已脱敏]" : redactValue(item),
    ]),
  );
}

function redactText(value: string): string {
  const marker = "\nProvider detail: ";
  const index = value.indexOf(marker);
  if (index >= 0) {
    try {
      return (
        redactText(value.slice(0, index)) +
        marker +
        JSON.stringify(redactValue(JSON.parse(value.slice(index + marker.length))))
      );
    } catch {
      /* Malformed historical details still receive text redaction. */
    }
  }
  return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已脱敏]@")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [已脱敏]")
    .replace(
      /((?:authorization|proxy-authorization|set-cookie|cookie)\s*:\s*)[^\r\n]+/gi,
      "$1[已脱敏]",
    )
    .replace(
      /(["']?(?:api[-_]?key|apikey|(?:access[-_]?|refresh[-_]?)?token|password|passwd|secret|client[-_]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&"']+)/gi,
      "$1[已脱敏]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
      "[已脱敏]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[已脱敏]")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "~")
    .replace(/[A-Z]:\\Users\\[^\\\s"']+/gi, "~");
}

export function copyDiagnostic(value: string): Promise<void> {
  return copyText(redactDiagnostic(value));
}
