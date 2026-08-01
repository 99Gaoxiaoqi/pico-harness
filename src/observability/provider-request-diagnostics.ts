import { createHash } from "node:crypto";
import { FULL_COMPACTION_SUMMARY_MARKER } from "../context/compaction-markers.js";
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
  /** 累积到真实或隐式协议虚拟断点的无明文快照；旧版持久记录可能缺失。 */
  cacheBreakpoints?: PreparedRequestCacheBreakpoint[];
  /** Hash only; never persists the compaction summary text. */
  fullCompactionSummaryHash?: string;
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
   * 按 tools → system → stable history 顺序逐内容断点比较，不含请求明文。
   * Anthropic 使用真实 cache_control；隐式协议使用同层级的虚拟前缀边界。
   * provider options 仍由 requestHash/changeReason 解释，不计入这些断点。
   */
  cacheBreakpointComparisons?: PreparedRequestCacheBreakpointComparison[];
  structuralChangeReason?: "full_compaction_summary_added_or_revised";
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
    ...fullCompactionSummaryCapture(request),
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
  const structuralChangeReason =
    current.fullCompactionSummaryHash !== undefined &&
    current.fullCompactionSummaryHash !== prior.fullCompactionSummaryHash
      ? "full_compaction_summary_added_or_revised"
      : undefined;
  return {
    ...current,
    changeReason:
      current.cachePrefixHash === prior.cachePrefixHash
        ? "request_changed"
        : "cacheable_prefix_changed",
    ...(firstChangedCacheableSegment ? { firstChangedCacheableSegment } : {}),
    ...(cacheBreakpointComparisons ? { cacheBreakpointComparisons } : {}),
    ...(structuralChangeReason ? { structuralChangeReason } : {}),
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
  const fullCompactionSummaryHash = value["fullCompactionSummaryHash"];
  if (
    (provider !== "claude" && provider !== "openai") ||
    typeof model !== "string" ||
    typeof requestHash !== "string" ||
    !isNonNegativeInteger(requestBytes) ||
    typeof cachePrefixHash !== "string" ||
    !Array.isArray(rawSegments) ||
    (rawCacheBreakpoints !== undefined && !Array.isArray(rawCacheBreakpoints)) ||
    (fullCompactionSummaryHash !== undefined &&
      (typeof fullCompactionSummaryHash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(fullCompactionSummaryHash)))
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
    ...(typeof fullCompactionSummaryHash === "string" ? { fullCompactionSummaryHash } : {}),
  };
}

function fullCompactionSummaryCapture(
  request: PreparedProviderRequest,
): Partial<Pick<PreparedRequestCapture, "fullCompactionSummaryHash">> {
  const messages = request.body["messages"];
  if (!Array.isArray(messages)) return {};
  const summaries: string[] = [];
  for (const message of messages) {
    collectMarkedStrings(message, summaries);
  }
  return summaries.length > 0 ? { fullCompactionSummaryHash: hash(serialize(summaries)) } : {};
}

function collectMarkedStrings(value: unknown, target: string[]): void {
  if (typeof value === "string") {
    if (value.startsWith(FULL_COMPACTION_SUMMARY_MARKER)) target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarkedStrings(item, target);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) collectMarkedStrings(child, target);
}

function cacheSegments(request: PreparedProviderRequest): PreparedRequestCacheSegments {
  const body = request.body;
  const candidates: PreparedRequestSegmentCandidate[] = [];
  const claimed = new Set<string>(["model"]);

  // Anthropic 的真实缓存顺序是 tools → system → messages；其他协议也沿用
  // 这套稳定诊断顺序，避免对象属性插入顺序影响“首个变化段”的解释。
  appendArraySegments(candidates, body["tools"], "tool_schema");
  claimed.add("tools");

  appendValueSegments(candidates, body["system"], "system_prompt");
  claimed.add("system");

  if (request.provider === "openai") {
    appendOpenAIMessages(candidates, body["messages"]);
  } else {
    appendArraySegments(candidates, body["messages"], "message", true);
  }
  claimed.add("messages");

  const explicitOpenAI =
    request.provider === "openai" &&
    isRecord(body["prompt_cache_options"]) &&
    body["prompt_cache_options"]["mode"] === "explicit";
  // Claude and GPT-5.6 explicit mode use real content breakpoints. OpenAI implicit mode treats
  // the newest message as the changing tail and synthesizes stable prefix boundaries before it.
  const cacheBoundary =
    request.provider === "claude" || explicitOpenAI
      ? candidates.findLastIndex((candidate) => candidate.cacheBreakpoint)
      : implicitStablePrefixBoundary(candidates);
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
    cacheBreakpoints:
      request.provider === "claude" || explicitOpenAI
        ? collectExplicitCacheBreakpoints(candidates, segments)
        : collectImplicitCacheBreakpoints(candidates, segments),
  };
}

function implicitStablePrefixBoundary(
  candidates: readonly PreparedRequestSegmentCandidate[],
): number {
  const lastMessage = candidates.findLastIndex((candidate) => candidate.segment.kind === "message");
  return lastMessage < 0 ? candidates.length - 1 : lastMessage - 1;
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

function appendOpenAIMessages(target: PreparedRequestSegmentCandidate[], value: unknown): void {
  if (!Array.isArray(value)) return;
  let systemIndex = target.filter((candidate) => candidate.segment.kind === "system_prompt").length;
  let messageIndex = 0;
  for (const item of value) {
    const role = isRecord(item) && typeof item["role"] === "string" ? item["role"] : undefined;
    if (role === "system" || role === "developer") {
      target.push(candidate("system_prompt", systemIndex++, item, role));
    } else {
      target.push(candidate("message", messageIndex++, item, role));
    }
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
  if ((kind !== "message" && kind !== "system_prompt") || !isRecord(value)) return false;
  const content = value["content"];
  return Array.isArray(content) && content.some((block) => hasDirectCacheBreakpoint(block));
}

function hasDirectCacheBreakpoint(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const cacheControl = value["cache_control"];
  if (isRecord(cacheControl) && cacheControl["type"] === "ephemeral") return true;
  const promptCacheBreakpoint = value["prompt_cache_breakpoint"];
  return isRecord(promptCacheBreakpoint) && promptCacheBreakpoint["mode"] === "explicit";
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

function collectExplicitCacheBreakpoints(
  candidates: PreparedRequestSegmentCandidate[],
  segments: PreparedRequestSegment[],
): PreparedRequestCacheBreakpoint[] {
  const layerIndexes: Record<PreparedRequestCacheBreakpointLayer, number> = {
    tools: 0,
    "tools+system": 0,
    history: 0,
  };
  const cacheBreakpoints: PreparedRequestCacheBreakpoint[] = [];
  const finalBoundary = candidates.findLastIndex((candidate) => candidate.cacheBreakpoint);
  // A later real breakpoint necessarily caches earlier tools/system. Add semantic checkpoints for
  // those layers even when the wire protocol (for example GPT-5.6) marks only the system block.
  for (const [kind, layer] of [
    ["tool_schema", "tools"],
    ["system_prompt", "tools+system"],
  ] as const) {
    const position = candidates.findLastIndex(
      (candidate, index) => index <= finalBoundary && candidate.segment.kind === kind,
    );
    const hasRealLayerBreakpoint = candidates.some(
      (candidate, index) =>
        index <= finalBoundary &&
        candidate.cacheBreakpoint &&
        cacheBreakpointLayer(candidate.segment.kind) === layer,
    );
    if (position >= 0 && !hasRealLayerBreakpoint) {
      const prefix = segments.slice(0, position + 1);
      cacheBreakpoints.push({
        layer,
        index: layerIndexes[layer]++,
        hash: hashCachePrefix(prefix),
        bytes: prefix.reduce((total, item) => total + item.bytes, 0),
      });
    }
  }
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

function collectImplicitCacheBreakpoints(
  candidates: readonly PreparedRequestSegmentCandidate[],
  segments: readonly PreparedRequestSegment[],
): PreparedRequestCacheBreakpoint[] {
  const positions: Array<[PreparedRequestCacheBreakpointLayer, number]> = [];
  const lastTool = candidates.findLastIndex(
    (candidate) => candidate.segment.kind === "tool_schema",
  );
  if (lastTool >= 0) positions.push(["tools", lastTool]);
  const lastSystem = candidates.findLastIndex(
    (candidate) => candidate.segment.kind === "system_prompt",
  );
  if (lastSystem >= 0) positions.push(["tools+system", lastSystem]);
  const messagePositions = candidates.flatMap((candidate, position) =>
    candidate.segment.kind === "message" ? [position] : [],
  );
  // The newest message is the request tail. A history boundary exists only when at least one
  // earlier message can be compared as a stable prefix.
  const stableHistory = messagePositions.at(-2);
  if (stableHistory !== undefined) positions.push(["history", stableHistory]);

  return positions.map(([layer, position]) => {
    const prefix = segments.slice(0, position + 1);
    return {
      layer,
      index: 0,
      hash: hashCachePrefix(prefix),
      bytes: prefix.reduce((total, item) => total + item.bytes, 0),
    };
  });
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
