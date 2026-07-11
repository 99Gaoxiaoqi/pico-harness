import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import React from "react";
import { Box, Text } from "ink";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import type { TuiToolCallProjection } from "./tui-event-store.js";

const DEFAULT_PAGE_BYTES = 16 * 1024;
const MIN_PAGE_BYTES = 256;
const MAX_PAGE_BYTES = 256 * 1024;
const SAFE_ARTIFACT_SEGMENT_RE = /^[A-Za-z0-9._-]+$/u;

export type InspectorSource = InlineInspectorSource | ArtifactInspectorSource;

export interface InlineInspectorSource {
  kind: "inline";
  title: string;
  content: string;
}

export interface ArtifactInspectorSource {
  kind: "artifact";
  title: string;
  artifactRef: string;
  artifactId: string;
  sessionId: string;
  /** 必须由宿主显式传入，一般为 <workDir>/.claw/artifacts。 */
  trustedRoot: string;
  /** 仅用于降级展示；分页和 locate 从可信 meta 重新解析，绝不直接使用它。 */
  markerPath?: string;
  summary?: string;
}

export interface InspectorPageRequest {
  offsetBytes?: number;
  limitBytes?: number;
}

export interface InspectorPage {
  title: string;
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number;
  totalBytes: number;
  eof: boolean;
  truncated: boolean;
  /** 宿主可直接交给剪贴板动作。 */
  copyText: string;
  /** 仅在 artifact meta 与可信根校验通过后提供。 */
  locatePath?: string;
  artifactRef?: string;
}

export interface InspectorProps {
  page: InspectorPage;
  maxLines?: number;
}

export function Inspector({ page, maxLines = 40 }: InspectorProps): React.ReactNode {
  const allLines = page.content.split("\n");
  const visibleLines = allLines.slice(0, Math.max(1, maxLines));
  return (
    <Box flexDirection="column">
      <Text bold>{page.title}</Text>
      <Text dimColor>
        bytes {page.offsetBytes}-{page.nextOffsetBytes} / {page.totalBytes}
      </Text>
      {visibleLines.map((line, index) => (
        <Text key={`${index}:${line}`} wrap="truncate">
          {line}
        </Text>
      ))}
      {allLines.length > visibleLines.length ? (
        <Text dimColor>… 当前页还有 {allLines.length - visibleLines.length} 行</Text>
      ) : null}
      <Text dimColor>
        {page.eof ? "End" : "More available"} · Copy current page
        {page.locatePath ? " · Locate artifact" : ""}
      </Text>
    </Box>
  );
}

export function createInlineInspectorSource(title: string, content: string): InlineInspectorSource {
  return { kind: "inline", title, content };
}

export function createArtifactInspectorSource(input: {
  title: string;
  artifactRef: string;
  trustedRoot: string;
  markerPath?: string;
  summary?: string;
}): ArtifactInspectorSource | undefined {
  const identity = parseArtifactRef(input.artifactRef);
  if (!identity) return undefined;
  return {
    kind: "artifact",
    title: input.title,
    artifactRef: input.artifactRef,
    artifactId: identity.artifactId,
    sessionId: identity.sessionId,
    trustedRoot: input.trustedRoot,
    ...(input.markerPath !== undefined ? { markerPath: input.markerPath } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
}

/** 把权威 tool projection 转为 Inspector 数据源；无效 artifactRef 自动降级为文本。 */
export function createToolInspectorSource(
  tool: TuiToolCallProjection,
  trustedArtifactRoot?: string,
): InspectorSource | undefined {
  const title = `${tool.name} result`;
  if (tool.artifactRef && trustedArtifactRoot) {
    const artifact = createArtifactInspectorSource({
      title,
      artifactRef: tool.artifactRef,
      trustedRoot: trustedArtifactRoot,
      ...(tool.artifactPath !== undefined ? { markerPath: tool.artifactPath } : {}),
      ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
    });
    if (artifact) return artifact;
  }
  const content = tool.result ?? tool.summary;
  return content === undefined ? undefined : createInlineInspectorSource(title, content);
}

export async function readInspectorPage(
  source: InspectorSource,
  request: InspectorPageRequest = {},
): Promise<InspectorPage> {
  const offsetBytes = normalizeOffset(request.offsetBytes);
  const limitBytes = normalizeLimit(request.limitBytes);
  if (source.kind === "inline") {
    const buffer = Buffer.from(source.content, "utf8");
    const page = readBufferPage(buffer, offsetBytes, limitBytes);
    return {
      title: source.title,
      ...page,
      truncated: !page.eof,
      copyText: page.content,
    };
  }

  const store = new ToolResultArtifactStore({ baseDir: source.trustedRoot });
  const meta = await store.readMeta(source.artifactId, source.sessionId);
  if (
    !meta ||
    meta.id !== source.artifactId ||
    meta.sessionId !== source.sessionId ||
    meta.safeSessionId !== safeArtifactSessionId(source.sessionId)
  ) {
    throw new Error(`Artifact metadata not found: ${source.artifactRef}`);
  }
  const artifactPath = await resolveTrustedArtifactPath(source.trustedRoot, meta.path, {
    safeSessionId: meta.safeSessionId,
    artifactId: meta.id,
  });
  const handle = await open(artifactPath, "r");
  try {
    const info = await handle.stat();
    const safeOffset = Math.min(offsetBytes, info.size);
    const bytesToRead = Math.min(limitBytes, Math.max(0, info.size - safeOffset));
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, safeOffset);
    const page = readBufferPage(
      buffer.subarray(0, bytesRead),
      0,
      limitBytes,
      safeOffset,
      info.size,
    );
    return {
      title: source.title,
      ...page,
      truncated: !page.eof,
      copyText: page.content,
      locatePath: artifactPath,
      artifactRef: source.artifactRef,
    };
  } finally {
    await handle.close();
  }
}

export function parseArtifactRef(
  artifactRef: string,
): { sessionId: string; artifactId: string } | undefined {
  const match = /^artifact:\/\/([^/]+)\/([^/?#]+)$/u.exec(artifactRef.trim());
  if (!match) return undefined;
  try {
    const sessionId = decodeURIComponent(match[1]!);
    const artifactId = decodeURIComponent(match[2]!);
    if (!sessionId || !isSafeArtifactSegment(artifactId)) {
      return undefined;
    }
    return { sessionId, artifactId };
  } catch {
    return undefined;
  }
}

async function resolveTrustedArtifactPath(
  trustedRoot: string,
  metadataPath: string,
  identity: { safeSessionId: string; artifactId: string },
): Promise<string> {
  if (!isAbsolute(metadataPath)) throw new Error("Artifact metadata path must be absolute");
  if (
    !isSafeArtifactSegment(identity.safeSessionId) ||
    !isSafeArtifactSegment(identity.artifactId)
  ) {
    throw new Error("Artifact metadata contains an unsafe path segment");
  }
  const root = resolve(trustedRoot);
  const expected = resolve(
    root,
    "sessions",
    identity.safeSessionId,
    "tool-results",
    `${identity.artifactId}.txt`,
  );
  if (resolve(metadataPath) !== expected) {
    throw new Error("Artifact metadata path does not match the artifact store layout");
  }
  const [realRoot, realArtifact] = await Promise.all([realpath(root), realpath(expected)]);
  const child = relative(realRoot, realArtifact);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Artifact path escapes the trusted artifact root");
  }
  return realArtifact;
}

function isSafeArtifactSegment(value: string): boolean {
  return value !== "." && value !== ".." && SAFE_ARTIFACT_SEGMENT_RE.test(value);
}

function safeArtifactSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const safeBase = sanitized === "" || sanitized === "." || sanitized === ".." ? "_" : sanitized;
  if (safeBase === sessionId) return safeBase;
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
  return `${safeBase}-${suffix}`;
}

function readBufferPage(
  buffer: Buffer,
  offsetBytes: number,
  limitBytes: number,
  absoluteOffset = offsetBytes,
  absoluteTotal = buffer.length,
): Omit<InspectorPage, "title" | "truncated" | "copyText" | "locatePath" | "artifactRef"> {
  const localOffset = absoluteOffset === offsetBytes ? Math.min(offsetBytes, buffer.length) : 0;
  const available = buffer.subarray(localOffset, Math.min(buffer.length, localOffset + limitBytes));
  const absoluteEnd = absoluteOffset + available.length;
  const eof = absoluteEnd >= absoluteTotal;
  const utf8Length = eof ? available.length : validUtf8PrefixLength(available);
  const content = available.subarray(0, utf8Length).toString("utf8");
  return {
    content,
    offsetBytes: absoluteOffset,
    nextOffsetBytes: absoluteOffset + utf8Length,
    totalBytes: absoluteTotal,
    eof: absoluteOffset + utf8Length >= absoluteTotal,
  };
}

function validUtf8PrefixLength(buffer: Buffer): number {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let trim = 0; trim <= Math.min(3, buffer.length); trim++) {
    const length = buffer.length - trim;
    try {
      decoder.decode(buffer.subarray(0, length));
      return length;
    } catch {
      // UTF-8 code point may cross the page boundary; at most three bytes trail it.
    }
  }
  throw new Error("Artifact page is not valid UTF-8 text");
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_BYTES;
  return Math.min(MAX_PAGE_BYTES, Math.max(MIN_PAGE_BYTES, Math.floor(value)));
}
