import { createHash } from "node:crypto";
import type { PreparedProviderRequest } from "../provider/interface.js";

export type PreparedRequestSegmentKind =
  | "tool_schema"
  | "system_prompt"
  | "message"
  | "provider_options";

export interface PreparedRequestSegment {
  kind: PreparedRequestSegmentKind;
  index: number;
  cacheable: boolean;
  hash: string;
  bytes: number;
  role?: string;
}

export type PreparedRequestCacheBreakpointLayer = "tools" | "tools+system" | "history";

export interface PreparedRequestCacheBreakpoint {
  layer: PreparedRequestCacheBreakpointLayer;
  index: number;
  hash: string;
  /** 累计规范化分段 JSON payload 的 UTF-8 字节；不是 token 数或完整 wire prefix 字节。 */
  bytes: number;
}

export interface PreparedRequestCapture {
  schemaVersion: 1;
  provider: PreparedProviderRequest["provider"];
  model: string;
  requestHash: string;
  requestBytes: number;
  cachePrefixHash: string;
  segments: PreparedRequestSegment[];
  /** 累积到各真实 cache_control 断点的无明文快照；旧版持久记录可能缺失。 */
  cacheBreakpoints?: PreparedRequestCacheBreakpoint[];
}

export type PreparedRequestChangeReason =
  | "first_request"
  | "stable"
  | "request_changed"
  | "cacheable_prefix_changed";

export type PreparedRequestCacheBreakpointChangeReason =
  | "first_request"
  | "prior_unavailable"
  | "stable"
  | "changed"
  | "added"
  | "removed";

export interface PreparedRequestCacheBreakpointSnapshot {
  hash: string;
  bytes: number;
}

export interface PreparedRequestCacheBreakpointComparison {
  layer: PreparedRequestCacheBreakpointLayer;
  index: number;
  changeReason: PreparedRequestCacheBreakpointChangeReason;
  prior?: PreparedRequestCacheBreakpointSnapshot;
  current?: PreparedRequestCacheBreakpointSnapshot;
}

export interface PreparedRequestDiagnostic extends PreparedRequestCapture {
  changeReason: PreparedRequestChangeReason;
  firstChangedCacheableSegment?: Pick<PreparedRequestSegment, "kind" | "index" | "role">;
  /**
   * 按 Anthropic tools → system → messages 顺序逐显式内容断点比较，不含请求明文。
   * provider options 仍由 requestHash/changeReason 解释，不计入这些断点。
   */
  cacheBreakpointComparisons?: PreparedRequestCacheBreakpointComparison[];
}

interface PreparedRequestSegmentCandidate {
  segment: PreparedRequestSegment;
  cacheBreakpoint: boolean;
}

interface PreparedRequestCacheSegments {
  segments: PreparedRequestSegment[];
  cacheBreakpoints: PreparedRequestCacheBreakpoint[];
}

/**
 * 对 Provider 即将 JSON.stringify 的请求体生成精确指纹。
 *
 * 只保留 SHA-256、字节数和分段元数据，不返回或持久化 prompt 明文。
 */
export function capturePreparedProviderRequest(
  request: PreparedProviderRequest,
): PreparedRequestCapture {
  const requestJson = serialize(request.body);
  const { segments, cacheBreakpoints } = cacheSegments(request);
  return {
    schemaVersion: 1,
    provider: request.provider,
    model: request.model,
    requestHash: hash(`${request.provider}\0${request.model}\0${requestJson}`),
    requestBytes: Buffer.byteLength(requestJson, "utf8"),
    cachePrefixHash: hashCachePrefix(segments.filter((segment) => segment.cacheable)),
    segments,
    cacheBreakpoints,
  };
}

/** 与同一会话、Provider、模型的上一份物理请求比较。 */
export function diagnosePreparedProviderRequest(
  current: PreparedRequestCapture,
  prior?: PreparedRequestCapture,
): PreparedRequestDiagnostic {
  const cacheBreakpointComparisons = compareCacheBreakpoints(current, prior);
  if (!prior) {
    return {
      ...current,
      changeReason: "first_request",
      ...(cacheBreakpointComparisons ? { cacheBreakpointComparisons } : {}),
    };
  }
  if (current.requestHash === prior.requestHash) {
    return {
      ...current,
      changeReason: "stable",
      ...(cacheBreakpointComparisons ? { cacheBreakpointComparisons } : {}),
    };
  }
  const firstChangedCacheableSegment = findFirstChangedCacheableSegment(current, prior);
  return {
    ...current,
    changeReason:
      current.cachePrefixHash === prior.cachePrefixHash
        ? "request_changed"
        : "cacheable_prefix_changed",
    ...(firstChangedCacheableSegment ? { firstChangedCacheableSegment } : {}),
    ...(cacheBreakpointComparisons ? { cacheBreakpointComparisons } : {}),
  };
}

/** 从 provider_calls.reported 中恢复上一份无明文请求指纹。 */
export function parsePreparedRequestCapture(value: unknown): PreparedRequestCapture | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== 1) return undefined;
  const provider = value["provider"];
  const model = value["model"];
  const requestHash = value["requestHash"];
  const requestBytes = value["requestBytes"];
  const cachePrefixHash = value["cachePrefixHash"];
  const rawSegments = value["segments"];
  const rawCacheBreakpoints = value["cacheBreakpoints"];
  if (
    (provider !== "claude" && provider !== "openai" && provider !== "gemini") ||
    typeof model !== "string" ||
    typeof requestHash !== "string" ||
    !isNonNegativeInteger(requestBytes) ||
    typeof cachePrefixHash !== "string" ||
    !Array.isArray(rawSegments) ||
    (rawCacheBreakpoints !== undefined && !Array.isArray(rawCacheBreakpoints))
  ) {
    return undefined;
  }
  const segments: PreparedRequestSegment[] = [];
  for (const raw of rawSegments) {
    const segment = parseSegment(raw);
    if (!segment) return undefined;
    segments.push(segment);
  }
  const cacheBreakpoints: PreparedRequestCacheBreakpoint[] = [];
  if (rawCacheBreakpoints) {
    for (const raw of rawCacheBreakpoints) {
      const cacheBreakpoint = parseCacheBreakpoint(raw);
      if (!cacheBreakpoint) return undefined;
      cacheBreakpoints.push(cacheBreakpoint);
    }
  }
  return {
    schemaVersion: 1,
    provider,
    model,
    requestHash,
    requestBytes,
    cachePrefixHash,
    segments,
    ...(rawCacheBreakpoints ? { cacheBreakpoints } : {}),
  };
}

function cacheSegments(request: PreparedProviderRequest): PreparedRequestCacheSegments {
  const body = request.body;
  const candidates: PreparedRequestSegmentCandidate[] = [];
  const claimed = new Set<string>(["model"]);

  // Anthropic 的真实缓存顺序是 tools → system → messages；其他协议也沿用
  // 这套稳定诊断顺序，避免对象属性插入顺序影响“首个变化段”的解释。
  appendArraySegments(candidates, body["tools"], "tool_schema");
  claimed.add("tools");

  const systemKey = request.provider === "gemini" ? "system_instruction" : "system";
  appendValueSegments(candidates, body[systemKey], "system_prompt");
  claimed.add(systemKey);

  const messagesKey = request.provider === "gemini" ? "contents" : "messages";
  appendArraySegments(candidates, body[messagesKey], "message", true);
  claimed.add(messagesKey);

  // Claude 只有最后一个显式 cache_control 断点及其之前的内容属于真实缓存前缀。
  // OpenAI/Gemini 使用服务端隐式前缀缓存，因此其协议内容均视为潜在可缓存。
  const cacheBoundary =
    request.provider === "claude"
      ? candidates.findLastIndex((candidate) => candidate.cacheBreakpoint)
      : candidates.length - 1;
  const segments = candidates.map(({ segment: candidate }, index) => ({
    ...candidate,
    cacheable: index <= cacheBoundary,
  }));

  const providerOptions = Object.fromEntries(
    Object.entries(body).filter(([key]) => !claimed.has(key)),
  );
  if (Object.keys(providerOptions).length > 0) {
    segments.push(segment("provider_options", 0, providerOptions, false));
  }
  return {
    segments,
    cacheBreakpoints: collectCacheBreakpoints(candidates, segments),
  };
}

function appendValueSegments(
  target: PreparedRequestSegmentCandidate[],
  value: unknown,
  kind: PreparedRequestSegmentKind,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      target.push(candidate(kind, index, item));
    }
    return;
  }
  target.push(candidate(kind, 0, value));
}

function appendArraySegments(
  target: PreparedRequestSegmentCandidate[],
  value: unknown,
  kind: PreparedRequestSegmentKind,
  includeRole = false,
): void {
  if (!Array.isArray(value)) return;
  for (const [index, item] of value.entries()) {
    const role =
      includeRole && isRecord(item) && typeof item["role"] === "string" ? item["role"] : undefined;
    target.push(candidate(kind, index, item, role));
  }
}

function candidate(
  kind: PreparedRequestSegmentKind,
  index: number,
  value: unknown,
  role?: string,
): PreparedRequestSegmentCandidate {
  return {
    segment: segment(kind, index, value, false, role),
    cacheBreakpoint: hasCacheBreakpoint(kind, value),
  };
}

function hasCacheBreakpoint(kind: PreparedRequestSegmentKind, value: unknown): boolean {
  if (hasDirectCacheBreakpoint(value)) return true;
  if (kind !== "message" || !isRecord(value)) return false;
  const content = value["content"];
  return Array.isArray(content) && content.some((block) => hasDirectCacheBreakpoint(block));
}

function hasDirectCacheBreakpoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const cacheControl = value["cache_control"];
  return isRecord(cacheControl) && cacheControl["type"] === "ephemeral";
}

function segment(
  kind: PreparedRequestSegmentKind,
  index: number,
  value: unknown,
  cacheable: boolean,
  role?: string,
): PreparedRequestSegment {
  const serialized = serialize(value);
  return {
    kind,
    index,
    cacheable,
    hash: hash(serialized),
    bytes: Buffer.byteLength(serialized, "utf8"),
    ...(role ? { role } : {}),
  };
}

function collectCacheBreakpoints(
  candidates: PreparedRequestSegmentCandidate[],
  segments: PreparedRequestSegment[],
): PreparedRequestCacheBreakpoint[] {
  const layerIndexes: Record<PreparedRequestCacheBreakpointLayer, number> = {
    tools: 0,
    "tools+system": 0,
    history: 0,
  };
  const cacheBreakpoints: PreparedRequestCacheBreakpoint[] = [];
  for (const [position, candidate] of candidates.entries()) {
    if (!candidate.cacheBreakpoint) continue;
    const layer = cacheBreakpointLayer(candidate.segment.kind);
    if (!layer) continue;
    const prefix = segments.slice(0, position + 1);
    cacheBreakpoints.push({
      layer,
      index: layerIndexes[layer]++,
      hash: hashCachePrefix(prefix),
      bytes: prefix.reduce((total, item) => total + item.bytes, 0),
    });
  }
  return cacheBreakpoints;
}

function cacheBreakpointLayer(
  kind: PreparedRequestSegmentKind,
): PreparedRequestCacheBreakpointLayer | undefined {
  if (kind === "tool_schema") return "tools";
  if (kind === "system_prompt") return "tools+system";
  if (kind === "message") return "history";
  return undefined;
}

function compareCacheBreakpoints(
  current: PreparedRequestCapture,
  prior?: PreparedRequestCapture,
): PreparedRequestCacheBreakpointComparison[] | undefined {
  const currentBreakpoints = current.cacheBreakpoints;
  if (!currentBreakpoints) return undefined;
  if (!prior) {
    return currentBreakpoints.map((cacheBreakpoint) =>
      breakpointComparison(cacheBreakpoint, undefined, "first_request"),
    );
  }
  const priorBreakpoints = prior.cacheBreakpoints;
  if (!priorBreakpoints) {
    return currentBreakpoints.map((cacheBreakpoint) =>
      breakpointComparison(cacheBreakpoint, undefined, "prior_unavailable"),
    );
  }

  const currentByKey = new Map(
    currentBreakpoints.map((cacheBreakpoint) => [
      cacheBreakpointKey(cacheBreakpoint),
      cacheBreakpoint,
    ]),
  );
  const priorByKey = new Map(
    priorBreakpoints.map((cacheBreakpoint) => [
      cacheBreakpointKey(cacheBreakpoint),
      cacheBreakpoint,
    ]),
  );
  const orderedKeys = new Set([...priorByKey.keys(), ...currentByKey.keys()]);
  return [...orderedKeys]
    .map((key) => {
      const currentBreakpoint = currentByKey.get(key);
      const priorBreakpoint = priorByKey.get(key);
      if (!currentBreakpoint) {
        return breakpointComparison(undefined, priorBreakpoint, "removed");
      }
      if (!priorBreakpoint) {
        return breakpointComparison(currentBreakpoint, undefined, "added");
      }
      return breakpointComparison(
        currentBreakpoint,
        priorBreakpoint,
        currentBreakpoint.hash === priorBreakpoint.hash &&
          currentBreakpoint.bytes === priorBreakpoint.bytes
          ? "stable"
          : "changed",
      );
    })
    .sort(compareBreakpointOrder);
}

function breakpointComparison(
  current: PreparedRequestCacheBreakpoint | undefined,
  prior: PreparedRequestCacheBreakpoint | undefined,
  changeReason: PreparedRequestCacheBreakpointChangeReason,
): PreparedRequestCacheBreakpointComparison {
  const identity = current ?? prior;
  if (!identity) throw new Error("Cache breakpoint comparison requires a breakpoint");
  return {
    layer: identity.layer,
    index: identity.index,
    changeReason,
    ...(prior ? { prior: breakpointSnapshot(prior) } : {}),
    ...(current ? { current: breakpointSnapshot(current) } : {}),
  };
}

function breakpointSnapshot(
  cacheBreakpoint: PreparedRequestCacheBreakpoint,
): PreparedRequestCacheBreakpointSnapshot {
  return {
    hash: cacheBreakpoint.hash,
    bytes: cacheBreakpoint.bytes,
  };
}

function cacheBreakpointKey(
  cacheBreakpoint: Pick<PreparedRequestCacheBreakpoint, "layer" | "index">,
): string {
  return `${cacheBreakpoint.layer}\0${cacheBreakpoint.index}`;
}

function compareBreakpointOrder(
  left: PreparedRequestCacheBreakpointComparison,
  right: PreparedRequestCacheBreakpointComparison,
): number {
  const layers: PreparedRequestCacheBreakpointLayer[] = ["tools", "tools+system", "history"];
  return layers.indexOf(left.layer) - layers.indexOf(right.layer) || left.index - right.index;
}

function hashCachePrefix(segments: PreparedRequestSegment[]): string {
  return hash(
    JSON.stringify(
      segments.map(({ kind, index, role, hash: segmentHash }) => ({
        kind,
        index,
        ...(role ? { role } : {}),
        hash: segmentHash,
      })),
    ),
  );
}

function findFirstChangedCacheableSegment(
  current: PreparedRequestCapture,
  prior: PreparedRequestCapture,
): PreparedRequestDiagnostic["firstChangedCacheableSegment"] {
  const currentSegments = current.segments.filter((segment) => segment.cacheable);
  const priorSegments = prior.segments.filter((segment) => segment.cacheable);
  const count = Math.max(currentSegments.length, priorSegments.length);
  for (let position = 0; position < count; position += 1) {
    const currentSegment = currentSegments[position];
    const priorSegment = priorSegments[position];
    if (
      currentSegment?.kind === priorSegment?.kind &&
      currentSegment?.index === priorSegment?.index &&
      currentSegment?.hash === priorSegment?.hash
    ) {
      continue;
    }
    const changed = currentSegment ?? priorSegment;
    if (!changed) return undefined;
    return {
      kind: changed.kind,
      index: changed.index,
      ...(changed.role ? { role: changed.role } : {}),
    };
  }
  return undefined;
}

function parseSegment(value: unknown): PreparedRequestSegment | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const index = value["index"];
  const cacheable = value["cacheable"];
  const segmentHash = value["hash"];
  const bytes = value["bytes"];
  const role = value["role"];
  if (
    (kind !== "tool_schema" &&
      kind !== "system_prompt" &&
      kind !== "message" &&
      kind !== "provider_options") ||
    !isNonNegativeInteger(index) ||
    typeof cacheable !== "boolean" ||
    typeof segmentHash !== "string" ||
    !isNonNegativeInteger(bytes) ||
    (role !== undefined && typeof role !== "string")
  ) {
    return undefined;
  }
  return {
    kind,
    index,
    cacheable,
    hash: segmentHash,
    bytes,
    ...(role ? { role } : {}),
  };
}

function parseCacheBreakpoint(value: unknown): PreparedRequestCacheBreakpoint | undefined {
  if (!isRecord(value)) return undefined;
  const layer = value["layer"];
  const index = value["index"];
  const cacheBreakpointHash = value["hash"];
  const bytes = value["bytes"];
  if (
    (layer !== "tools" && layer !== "tools+system" && layer !== "history") ||
    !isNonNegativeInteger(index) ||
    typeof cacheBreakpointHash !== "string" ||
    !isNonNegativeInteger(bytes)
  ) {
    return undefined;
  }
  return {
    layer,
    index,
    hash: cacheBreakpointHash,
    bytes,
  };
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Provider request contains a non-JSON value");
  return serialized;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
