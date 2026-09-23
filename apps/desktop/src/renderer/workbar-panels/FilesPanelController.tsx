import type { RuntimeSessionArtifact } from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  FilesWorkbarPanel,
  type WorkbarArtifact,
  type WorkbarArtifactContent,
} from "./FilesWorkbarPanel.js";
import { useResourceFrame } from "./useResourceFrame.js";
import type { WorkbarPanelHostProps, WorkbarScope } from "./workbar-panel-contract.js";
import { invokeWorkbarRuntime, QUERY_PAGE_SIZE, workbarErrorMessage } from "./workbar-runtime.js";
import { isRecord, numberField, stringField, timestampText } from "./workbar-values.js";
import { artifactPreviewKind, artifactPreviewLimit } from "./artifact-preview-model.js";

const ARTIFACT_CHUNK_BYTES = 32 * 1024;

export function FilesPanelController({ workspacePath, sessionId, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [artifacts, setArtifacts] = useState<readonly WorkbarArtifact[]>([]);
  const [revision, setRevision] = useState<number>();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [content, setContent] = useState<WorkbarArtifactContent>();
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [contentError, setContentError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const streamRef = useRef<ArtifactStreamAccumulator | undefined>(undefined);
  const requestRef = useRef(0);
  const contentRequestRef = useRef(0);
  const selectedArtifactRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await queryAllWorkbarArtifacts(runtime, scope);
      if (request !== requestRef.current) return;
      setArtifacts(next.artifacts);
      setRevision(next.revision);
      const selected = selectedArtifactRef.current;
      if (selected && !next.artifacts.some((artifact) => artifact.id === selected)) {
        selectedArtifactRef.current = undefined;
        contentRequestRef.current += 1;
        streamRef.current = undefined;
        setSelectedArtifactId(undefined);
        setContent(undefined);
        setContentLoading(false);
        setContentError(undefined);
        setNotice("该生成文件已不存在，已返回列表。");
      }
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, scope]);

  useEffect(() => {
    setContentLoading(false);
    if (streamRef.current) setContent(artifactContentView(streamRef.current));
    if (active) void refresh();
    return () => {
      requestRef.current += 1;
      contentRequestRef.current += 1;
    };
  }, [active, refresh]);

  useResourceFrame({ active, sessionId, resource: "artifacts", revision }, refresh);

  const loadChunk = useCallback(
    async (artifactId: string, offset: number) => {
      if (!active) return;
      const request = ++contentRequestRef.current;
      setContentLoading(true);
      setContentError(undefined);
      try {
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact) throw new Error("生成文件已从当前 Session 移除。");
        const limit = artifactPreviewLimit(artifact);
        const kind = artifactPreviewKind(artifact);
        if (kind === "unsupported")
          throw new Error("此文件格式不支持内嵌预览，请打开或另存后查看。");
        if ((kind === "image" || kind === "pdf") && artifact.size > limit)
          throw new Error(`文件超过 ${limit / (1024 * 1024)} MiB 预览上限，请另存后查看。`);
        if (offset >= limit) throw new Error("已达到内嵌预览上限，请另存后查看。");
        let nextOffset = offset;
        do {
          const value = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
            ...scope,
            action: "read_chunk",
            artifactId,
            offsetBytes: nextOffset,
            limitBytes: Math.min(ARTIFACT_CHUNK_BYTES, limit - nextOffset),
          });
          if (request !== contentRequestRef.current || selectedArtifactRef.current !== artifactId) {
            return;
          }
          const envelope = parseArtifactChunk(value);
          const previous = nextOffset === 0 ? undefined : streamRef.current;
          const next = appendArtifactStreamChunk(previous, artifact, envelope);
          streamRef.current = next;
          // Avoid repeatedly encoding the entire accumulated binary for every
          // 32 KiB chunk. Binary decoders only receive a complete bounded file.
          if (next.complete || (kind !== "image" && kind !== "pdf")) {
            setContent(artifactContentView(next));
          }
          nextOffset = next.nextOffset;
          if (next.complete || nextOffset >= limit || !["html", "image", "pdf"].includes(kind))
            break;
        } while (request === contentRequestRef.current);
      } catch (cause) {
        if (request === contentRequestRef.current) setContentError(workbarErrorMessage(cause));
      } finally {
        if (request === contentRequestRef.current) setContentLoading(false);
      }
    },
    [active, artifacts, runtime, scope],
  );

  const selectArtifact = useCallback(
    (artifactId: string) => {
      selectedArtifactRef.current = artifactId;
      setSelectedArtifactId(artifactId);
      setNotice(undefined);
      setContentError(undefined);
      streamRef.current = undefined;
      setContent(undefined);
      void loadChunk(artifactId, 0);
    },
    [loadChunk],
  );

  const backToList = useCallback(() => {
    selectedArtifactRef.current = undefined;
    contentRequestRef.current += 1;
    streamRef.current = undefined;
    setSelectedArtifactId(undefined);
    setContent(undefined);
    setContentLoading(false);
    setContentError(undefined);
  }, []);

  const exportArtifact = async (
    artifactId: string,
    action: "open" | "saveAs" | "openInDefaultApp",
  ) => {
    setContentError(undefined);
    try {
      const result = await window.pico.artifacts[action]({ ...scope, artifactId });
      if (!result.ok) throw new Error(result.error.message);
    } catch (cause) {
      setContentError(workbarErrorMessage(cause));
    }
  };

  return (
    <FilesWorkbarPanel
      artifacts={artifacts}
      selectedArtifactId={selectedArtifactId}
      content={content}
      loading={loading}
      contentLoading={contentLoading}
      error={error}
      contentError={contentError}
      notice={notice}
      onRefresh={() => void refresh()}
      onSelectArtifact={selectArtifact}
      onBack={backToList}
      onLoadChunk={(artifactId, offset) => void loadChunk(artifactId, offset)}
      onOpenArtifact={(artifactId) => void exportArtifact(artifactId, "open")}
      onOpenDefaultApp={(artifactId) => void exportArtifact(artifactId, "openInDefaultApp")}
      onSaveArtifactAs={(artifactId) => void exportArtifact(artifactId, "saveAs")}
    />
  );
}

interface ArtifactListResult {
  readonly revision: number;
  readonly artifacts: readonly WorkbarArtifact[];
}

export async function queryAllWorkbarArtifacts(
  runtime: DesktopRuntimeApi,
  scope: WorkbarScope,
): Promise<ArtifactListResult> {
  let cursor: string | undefined;
  let revision: number | undefined;
  const artifacts: WorkbarArtifact[] = [];
  do {
    const value = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
      ...scope,
      action: "list",
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(revision === undefined ? {} : { revision }),
    });
    const page = parseArtifactPage(value);
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error("生成文件分页版本发生变化，请重试。");
    artifacts.push(...page.artifacts.map(artifactView));
    cursor = page.nextCursor;
  } while (cursor);
  return { revision: revision ?? 0, artifacts };
}

export interface ArtifactChunkEnvelope {
  readonly contentBase64: string;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly nextOffsetBytes?: number;
}

export interface ArtifactStreamAccumulator {
  readonly artifactId: string;
  readonly encoding: "utf8" | "base64";
  readonly bytes: Uint8Array;
  readonly nextOffset: number;
  readonly totalSize: number;
  readonly complete: boolean;
  readonly truncated: boolean;
}

export function appendArtifactStreamChunk(
  previous: ArtifactStreamAccumulator | undefined,
  artifact: WorkbarArtifact,
  chunk: ArtifactChunkEnvelope,
): ArtifactStreamAccumulator {
  const expectedOffset = previous?.nextOffset ?? 0;
  if (previous && previous.artifactId !== artifact.id) {
    throw new Error("生成文件分块不能跨 Artifact 合并。");
  }
  if (chunk.offsetBytes !== expectedOffset || chunk.endOffsetBytes < chunk.offsetBytes) {
    throw new Error(`生成文件分块不连续：expected ${expectedOffset}, actual ${chunk.offsetBytes}`);
  }
  const decoded = decodeBase64(chunk.contentBase64);
  if (decoded.byteLength !== chunk.endOffsetBytes - chunk.offsetBytes) {
    throw new Error("生成文件分块长度与 authority 返回的字节范围不一致。");
  }
  if (
    chunk.totalBytes < chunk.endOffsetBytes ||
    (previous && previous.totalSize !== chunk.totalBytes) ||
    (chunk.truncated && (chunk.nextOffsetBytes !== chunk.endOffsetBytes || decoded.length === 0)) ||
    (!chunk.truncated && chunk.endOffsetBytes !== chunk.totalBytes)
  ) {
    throw new Error("生成文件分块范围或总长度发生变化。");
  }
  if (chunk.endOffsetBytes > artifactPreviewLimit(artifact))
    throw new Error("生成文件内容超过内嵌预览上限。");
  if (
    ["image", "pdf"].includes(artifactPreviewKind(artifact)) &&
    chunk.totalBytes > artifactPreviewLimit(artifact)
  )
    throw new Error("生成文件内容超过内嵌预览上限。");
  const bytes = concatBytes(previous?.bytes, decoded);
  const nextOffset = chunk.nextOffsetBytes ?? chunk.endOffsetBytes;
  const complete = !chunk.truncated || nextOffset >= chunk.totalBytes;
  return {
    artifactId: artifact.id,
    encoding:
      isTextArtifact(artifact.mimeType) || artifactPreviewKind(artifact) === "diff"
        ? "utf8"
        : "base64",
    bytes,
    nextOffset,
    totalSize: chunk.totalBytes,
    complete,
    truncated: !complete,
  };
}

export function artifactContentView(stream: ArtifactStreamAccumulator): WorkbarArtifactContent {
  return {
    artifactId: stream.artifactId,
    encoding: stream.encoding,
    content:
      stream.encoding === "utf8"
        ? new TextDecoder().decode(stream.bytes, { stream: !stream.complete })
        : encodeBase64(stream.bytes),
    offset: 0,
    nextOffset: stream.nextOffset,
    totalSize: stream.totalSize,
    complete: stream.complete,
    truncated: stream.truncated,
  };
}

function artifactView(artifact: RuntimeSessionArtifact): WorkbarArtifact {
  return {
    id: artifact.artifactId,
    name: artifact.title,
    mimeType: artifact.mimeType,
    size: artifact.sizeBytes,
    createdAt: timestampText(artifact.createdAt),
    digest: artifact.digest,
  };
}

function parseArtifactPage(value: unknown): {
  readonly revision: number;
  readonly artifacts: readonly RuntimeSessionArtifact[];
  readonly nextCursor?: string;
} {
  if (!isRecord(value)) throw new Error("生成文件 authority 返回了无效列表。");
  const revision = numberField(value, "revision");
  if (revision === undefined || !Array.isArray(value["artifacts"])) {
    throw new Error("生成文件 authority 返回了无效列表。");
  }
  const artifacts = value["artifacts"].filter(isRuntimeArtifact);
  if (artifacts.length !== value["artifacts"].length) {
    throw new Error("生成文件列表包含无效条目。");
  }
  return {
    revision,
    artifacts,
    ...(stringField(value, "nextCursor") ? { nextCursor: stringField(value, "nextCursor") } : {}),
  };
}

function parseArtifactChunk(value: unknown): ArtifactChunkEnvelope {
  if (!isRecord(value)) throw new Error("生成文件 authority 返回了无效分块。");
  const contentBase64 =
    typeof value["contentBase64"] === "string" ? value["contentBase64"] : undefined;
  const offsetBytes = numberField(value, "offsetBytes");
  const endOffsetBytes = numberField(value, "endOffsetBytes");
  const totalBytes = numberField(value, "totalBytes");
  if (
    contentBase64 === undefined ||
    offsetBytes === undefined ||
    endOffsetBytes === undefined ||
    totalBytes === undefined
  ) {
    throw new Error("生成文件 authority 返回了无效分块。");
  }
  return {
    contentBase64,
    offsetBytes,
    endOffsetBytes,
    totalBytes,
    truncated: value["truncated"] === true,
    ...(numberField(value, "nextOffsetBytes") === undefined
      ? {}
      : { nextOffsetBytes: numberField(value, "nextOffsetBytes") }),
  };
}

function isRuntimeArtifact(value: unknown): value is RuntimeSessionArtifact {
  return (
    isRecord(value) &&
    Boolean(stringField(value, "artifactId")) &&
    Boolean(stringField(value, "title")) &&
    Boolean(stringField(value, "mimeType")) &&
    Boolean(stringField(value, "digest")) &&
    numberField(value, "sizeBytes") !== undefined &&
    numberField(value, "createdAt") !== undefined &&
    numberField(value, "updatedAt") !== undefined
  );
}

function isTextArtifact(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  );
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("生成文件分块不是有效 Base64。");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return globalThis.btoa(binary);
}

function concatBytes(left: Uint8Array | undefined, right: Uint8Array): Uint8Array {
  if (!left || left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}
