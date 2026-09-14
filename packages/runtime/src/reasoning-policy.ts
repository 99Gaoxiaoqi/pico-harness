import type {
  JsonValue,
  ProviderProtocol,
  ReasoningLevelSelection,
  ReasoningRequestPatch,
  RequestBodyPath,
  ResolvedModelReasoningCapability,
} from "@pico/core";

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Preserve a selected level across model switches without inventing unsupported controls. */
export function coordinateReasoningLevel(
  capability: ResolvedModelReasoningCapability,
  requestedLevel?: string,
): ReasoningLevelSelection {
  if (capability.enabled !== true || capability.levels.length === 0) {
    return { changed: requestedLevel !== undefined, reason: "not_adjustable" };
  }

  const requested = requestedLevel?.trim().toLowerCase();
  const matched = requested
    ? capability.levels.find((level) => level.toLowerCase() === requested)
    : undefined;
  if (matched) return { level: matched, changed: false, reason: "requested" };

  const fallback = capability.defaultLevel ?? capability.levels[0];
  return {
    ...(fallback ? { level: fallback } : {}),
    changed: requestedLevel !== undefined && requestedLevel !== fallback,
    reason: requestedLevel === undefined ? "default" : "fallback",
  };
}

export function reasoningRequestPatchForLevel(
  capability: ResolvedModelReasoningCapability,
  level: string | undefined,
  protocol: ProviderProtocol,
): ReasoningRequestPatch | undefined {
  if (!level) return undefined;
  const canonicalLevel = capability.levels.find(
    (candidate) => candidate.toLowerCase() === level.trim().toLowerCase(),
  );
  return canonicalLevel ? capability.providerOptionsByLevel[canonicalLevel]?.[protocol] : undefined;
}

/** Return a patched clone; caller-owned request objects are never mutated. */
export function applyRequestBodyPatch<T extends object>(
  body: T,
  requestPatch: ReasoningRequestPatch | undefined,
): T {
  if (!requestPatch) return body;
  const result = { ...(body as Record<string, unknown>) };
  for (const path of requestPatch.unset ?? []) unsetPath(result, path);
  for (const operation of requestPatch.set ?? []) {
    setPath(result, operation.path, operation.value);
  }
  return result as T;
}

export function applyReasoningRequestPatch<T extends object>(
  body: T,
  capability: ResolvedModelReasoningCapability,
  level: string | undefined,
  protocol: ProviderProtocol,
): T {
  return applyRequestBodyPatch(body, reasoningRequestPatchForLevel(capability, level, protocol));
}

function unsetPath(target: Record<string, unknown>, path: RequestBodyPath): void {
  validatePath(path);
  let cursor: Record<string, unknown> = target;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainRecord(next)) return;
    const clone = { ...next };
    cursor[segment] = clone;
    cursor = clone;
  }
  delete cursor[path[path.length - 1]!];
}

function setPath(target: Record<string, unknown>, path: RequestBodyPath, value: JsonValue): void {
  validatePath(path);
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    if (isPlainRecord(existing)) {
      const clone = { ...existing };
      cursor[segment] = clone;
      cursor = clone;
    } else {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
    }
  }
  cursor[path[path.length - 1]!] = value;
}

function validatePath(path: RequestBodyPath): void {
  if (path.length === 0 || path.some((segment) => !segment || UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`Unsafe reasoning request patch path: ${path.join(".")}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
