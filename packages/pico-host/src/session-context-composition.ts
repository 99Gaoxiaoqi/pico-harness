import type { Message } from "@pico/core";
import type {
  RuntimeContextComposition,
  RuntimeLatestContextRequest,
  RuntimeSessionContextSnapshot,
} from "@pico/protocol";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { parsePreparedRequestCapture } from "@pico/runtime/provider-request-diagnostics";
const MAX_TOOLS = 64;

/** Counts serialized semantic segments, not HTTP wire bytes and never inferred tokens. */
export function foldContextComposition(
  segments: readonly { kind: string; bytes: number; label?: string }[],
): RuntimeContextComposition | undefined {
  if (!segments.length || segments.some((s) => !Number.isSafeInteger(s.bytes) || s.bytes < 0))
    return undefined;
  const kinds = { system: 0, tools: 0, messages: 0, other: 0 };
  const tools = new Map<string, { bytes: number; count: number }>();
  let unlabelledToolBytes = 0;
  for (const segment of segments) {
    const kind =
      segment.kind === "system_prompt"
        ? "system"
        : segment.kind === "tool_schema"
          ? "tools"
          : segment.kind === "message"
            ? "messages"
            : "other";
    kinds[kind] += segment.bytes;
    if (kind === "tools") {
      if (segment.label && /^[A-Za-z0-9_.:-]{1,128}$/u.test(segment.label)) {
        const prior = tools.get(segment.label);
        tools.set(segment.label, {
          bytes: (prior?.bytes ?? 0) + segment.bytes,
          count: (prior?.count ?? 0) + 1,
        });
      } else unlabelledToolBytes += segment.bytes;
    }
  }
  const totalBytes = Object.values(kinds).reduce((n, bytes) => n + bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) return undefined;
  const ranked = [...tools]
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
  return {
    basis: "semantic_utf8_bytes",
    totalBytes,
    segments: (Object.keys(kinds) as (keyof typeof kinds)[]).map((kind) => ({
      kind,
      bytes: kinds[kind],
    })),
    tools: ranked.slice(0, MAX_TOOLS).map(({ label, bytes }) => ({ label, bytes })),
    remainingTools: ranked
      .slice(MAX_TOOLS)
      .reduce(
        (rest, tool) => ({ count: rest.count + tool.count, bytes: rest.bytes + tool.bytes }),
        { count: 0, bytes: 0 },
      ),
    unlabelledToolBytes,
  };
}

export function getLatestContextRequest(
  storageRoot: string,
  sessionId: string,
): RuntimeLatestContextRequest {
  const store = new SqliteRuntimeControlStore({ storageRoot });
  try {
    const record = store.getLatestContextAttempt(sessionId);
    if (!record)
      return {
        status: "unavailable",
        source: "none",
        usageStatus: "missing",
        compositionStatus: "unrecorded",
        reason: "尚无成功的主请求记录。",
      };
    const capture = parsePreparedRequestCapture(record.requestDiagnostic);
    const composition =
      capture?.model === record.model ? foldContextComposition(capture.segments) : undefined;
    const usage = record.usage;
    const fields = usage?.reportedFields ?? [];
    const facts = record.contextFacts!;
    return {
      status: "available",
      source: "physical",
      providerCallId: record.providerCallId,
      physicalAttemptId: record.physicalAttemptId,
      providerId: record.provider,
      modelId: record.model,
      completedAt: Date.parse(record.completedAt!),
      ...(facts.routeId ? { routeId: facts.routeId } : {}),
      ...(facts.connectionId ? { connectionId: facts.connectionId } : {}),
      ...(facts.contextWindow !== undefined ? { contextWindow: facts.contextWindow } : {}),
      ...(facts.contextWindowSource ? { contextWindowSource: facts.contextWindowSource } : {}),
      ...(facts.compaction ? { compaction: { ...facts.compaction } } : {}),
      ...(fields.includes("prompt") ? { inputTokens: usage!.promptTokens } : {}),
      ...(fields.includes("completion") ? { outputTokens: usage!.completionTokens } : {}),
      ...(fields.includes("cacheRead") ? { cachedInputTokens: usage!.cacheReadTokens } : {}),
      usageStatus: record.usageBasis,
      compositionStatus: composition ? "available" : "unrecorded",
      ...(composition ? { composition } : { reason: "该请求未记录可用组成；未借用其他请求。" }),
    };
  } finally {
    store.close();
  }
}

/** The newest transcript anchor stands on its own; never scan past a different route. */
export function readLastRequestAnchor(
  messages: readonly Message[],
): RuntimeSessionContextSnapshot["lastRequestAnchor"] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const anchor = messages[index]!.providerData?.["picoContextRequestAnchor"];
    if (!anchor || typeof anchor !== "object") continue;
    const value = anchor as Record<string, unknown>;
    if (
      typeof value.routeId !== "string" ||
      typeof value.modelId !== "string" ||
      typeof value.inputTokens !== "number" ||
      !Number.isFinite(value.inputTokens) ||
      value.inputTokens <= 0 ||
      typeof value.outputTokens !== "number" ||
      !Number.isFinite(value.outputTokens) ||
      value.outputTokens < 0
    )
      return undefined;
    return {
      routeId: value.routeId,
      modelId: value.modelId,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
    };
  }
  return undefined;
}
