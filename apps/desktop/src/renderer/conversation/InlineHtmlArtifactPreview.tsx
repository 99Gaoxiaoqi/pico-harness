import { useEffect, useMemo, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  artifactHtmlDocument,
  artifactPreviewKind,
  artifactPreviewLimit,
} from "../workbar-panels/artifact-preview-model.js";
import { invokeWorkbarRuntime } from "../workbar-panels/workbar-runtime.js";
import type { MediaScope } from "./MediaPreview.js";

const ARTIFACT_CHUNK_BYTES = 32 * 1024;

interface HtmlArtifact {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly digest: string;
}

type PreviewState =
  | { readonly kind: "ready"; readonly artifact: HtmlArtifact; readonly html: string }
  | { readonly kind: "error"; readonly message: string };

export function InlineHtmlArtifactPreview({
  artifactId,
  scope,
}: {
  readonly artifactId: string;
  readonly scope: MediaScope;
}) {
  const [state, setState] = useState<PreviewState>();
  const srcDoc = useMemo(
    () => (state?.kind === "ready" ? artifactHtmlDocument(state.html) : ""),
    [state],
  );

  useEffect(() => {
    let active = true;
    setState(undefined);
    void loadHtmlArtifact(window.pico.runtime, scope, artifactId)
      .then((result) => {
        if (active && result) setState({ kind: "ready", ...result });
      })
      .catch((cause: unknown) => {
        if (active)
          setState({
            kind: "error",
            message: cause instanceof Error ? cause.message : "HTML 预览载入失败。",
          });
      });
    return () => {
      active = false;
    };
  }, [artifactId, scope.workspacePath, scope.sessionId]);

  if (!state) return null;
  if (state.kind === "error")
    return (
      <span className="conversation-artifact-link__html" role="alert">
        HTML 预览失败：{state.message}
      </span>
    );
  return (
    <span className="conversation-artifact-link__html">
      <iframe
        title={`${state.artifact.name} HTML 预览`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </span>
  );
}

async function loadHtmlArtifact(
  runtime: DesktopRuntimeApi,
  scope: MediaScope,
  artifactId: string,
): Promise<{ readonly artifact: HtmlArtifact; readonly html: string } | undefined> {
  let metadata: unknown;
  try {
    metadata = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
      ...scope,
      action: "get",
      artifactId,
    });
  } catch {
    // Ordinary artifact links remain available through their existing open/save actions.
    return undefined;
  }

  const metadataRecord = record(metadata);
  const artifacts = metadataRecord["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length !== 1) return undefined;
  const value = record(artifacts[0]);
  if (
    value["artifactId"] !== artifactId ||
    typeof value["title"] !== "string" ||
    typeof value["mimeType"] !== "string" ||
    typeof value["digest"] !== "string" ||
    !Number.isSafeInteger(value["sizeBytes"]) ||
    Number(value["sizeBytes"]) < 0
  )
    return undefined;

  const artifact: HtmlArtifact = {
    id: artifactId,
    name: value["title"],
    mimeType: value["mimeType"],
    digest: value["digest"],
    size: Number(value["sizeBytes"]),
  };
  if (artifactPreviewKind(artifact) !== "html") return undefined;
  if (!/^[a-f0-9]{64}$/u.test(artifact.digest)) throw new Error("文件摘要无效。");
  if (artifact.size <= 0 || artifact.size > artifactPreviewLimit(artifact))
    throw new Error("HTML 文件为空或超过 256 KiB 预览上限，请从生成文件面板打开。");

  const bytes = new Uint8Array(artifact.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const limit = Math.min(ARTIFACT_CHUNK_BYTES, bytes.byteLength - offset);
    const chunkValue = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
      ...scope,
      action: "read_chunk",
      artifactId,
      offsetBytes: offset,
      limitBytes: limit,
    });
    const chunk = record(chunkValue);
    const chunkArtifact = record(chunk["artifact"]);
    if (
      chunkArtifact["artifactId"] !== artifact.id ||
      chunkArtifact["sizeBytes"] !== artifact.size ||
      chunkArtifact["digest"] !== artifact.digest ||
      chunkArtifact["mimeType"] !== artifact.mimeType
    )
      throw new Error("HTML 分块的产物信息不一致。");

    const base64 = chunk["contentBase64"];
    const endOffset = chunk["endOffsetBytes"];
    const totalBytes = chunk["totalBytes"];
    const truncated = chunk["truncated"];
    const nextOffset = chunk["nextOffsetBytes"];
    if (
      typeof base64 !== "string" ||
      base64.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64) ||
      chunk["offsetBytes"] !== offset ||
      typeof endOffset !== "number" ||
      !Number.isSafeInteger(endOffset) ||
      endOffset <= offset ||
      endOffset - offset > limit ||
      totalBytes !== artifact.size ||
      typeof truncated !== "boolean" ||
      truncated !== endOffset < artifact.size ||
      (truncated && nextOffset !== endOffset) ||
      (!truncated && nextOffset !== undefined)
    )
      throw new Error("HTML 分块范围无效。");

    const decoded = decodeBase64(base64);
    if (decoded.byteLength !== endOffset - offset) throw new Error("HTML 分块长度不符。");
    bytes.set(decoded, offset);
    offset = endOffset;
  }

  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== artifact.digest) throw new Error("HTML 内容摘要校验失败。");

  return { artifact, html: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let encoded = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    encoded += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  if (btoa(encoded) !== value) throw new Error("HTML 分块 Base64 无效。");
  return bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("HTML 产物响应无效。");
  return value as Record<string, unknown>;
}
