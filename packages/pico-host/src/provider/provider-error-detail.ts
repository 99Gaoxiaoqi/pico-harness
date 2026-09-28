import type { ProviderErrorDetail } from "@pico/core";

/** Select a bounded local error summary, never the complete response or request payload. */
export function providerErrorDetail(
  value: unknown,
  requestId?: string,
): ProviderErrorDetail | undefined {
  if (typeof value === "string") {
    try {
      return providerErrorDetail(JSON.parse(value), requestId);
    } catch {
      return value.trim()
        ? {
            message: bounded(value, 2048),
            ...(requestId ? { requestId: bounded(requestId, 256) } : {}),
          }
        : undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const field = (key: string) => {
    try {
      return record[key];
    } catch {
      return undefined;
    }
  };
  const id = field("request_id") ?? field("requestId") ?? requestId;
  const safeId = typeof id === "string" ? bounded(id, 256) : undefined;
  for (const key of ["data", "responseBody", "error"]) {
    const nested = field(key);
    if (nested && nested !== value) {
      // Only inspect the known one-level SDK/provider envelopes, not arbitrary object graphs.
      const detail = envelopeDetail(nested, safeId);
      if (detail) return detail;
    }
  }
  return envelopeDetail(value, safeId);
}

function envelopeDetail(value: unknown, requestId?: string): ProviderErrorDetail | undefined {
  if (typeof value === "string") {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      return text.trim()
        ? { message: bounded(text, 2048), ...(requestId ? { requestId } : {}) }
        : undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  let record = value as Record<string, unknown>;
  if (record.error && typeof record.error === "object")
    record = record.error as Record<string, unknown>;
  if (typeof record.message !== "string" || !record.message.trim()) return undefined;
  const detail: ProviderErrorDetail = {
    message: bounded(record.message, 2048),
    ...(typeof record.code === "string" || typeof record.code === "number"
      ? { code: bounded(String(record.code), 256) }
      : {}),
    ...(typeof record.type === "string" ? { type: bounded(record.type, 256) } : {}),
    ...(requestId ? { requestId } : {}),
  };
  return detail;
}

function bounded(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  const suffix = "…[已截断]";
  const prefix = Buffer.from(value)
    .subarray(0, bytes - Buffer.byteLength(suffix))
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return prefix + suffix;
}
