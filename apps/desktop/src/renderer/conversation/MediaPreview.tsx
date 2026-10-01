import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { inspectMediaBytes, mediaPreviewLimit, type RuntimeMediaReference } from "@pico/protocol";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import { invokeWorkbarRuntime } from "../workbar-panels/workbar-runtime.js";

import { createPortal } from "react-dom";

void React;
export interface MediaScope {
  readonly workspacePath: string;
  readonly sessionId: string;
}
const MediaContext = createContext<
  | {
      scope: MediaScope;
      load: (reference: RuntimeMediaReference, signal: AbortSignal) => Promise<Uint8Array>;
    }
  | undefined
>(undefined);

function mediaReadQueue() {
  let active = 0;
  const pending: (() => void)[] = [];
  return <T,>(read: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        active++;
        void read()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pending.shift()?.();
          });
      };
      const cancel = () => {
        const index = pending.indexOf(start);
        if (index >= 0) pending.splice(index, 1);
        reject(signal.reason);
      };
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (active < 2) start();
      else {
        pending.push(start);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
}
export function MediaProvider({
  scope,
  children,
}: {
  scope?: MediaScope | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => {
    if (!scope) return undefined;
    const queue = mediaReadQueue();
    return {
      scope,
      load: (reference: RuntimeMediaReference, signal: AbortSignal) =>
        queue(() => loadMediaBytes(window.pico.runtime, scope, reference, signal), signal),
    };
  }, [scope?.workspacePath, scope?.sessionId]);
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

/** All URLs come from verified bounded bytes, never from model-authored metadata. */
export async function validateMediaPayload(
  bytes: Uint8Array,
  reference: RuntimeMediaReference,
): Promise<string> {
  if (
    bytes.byteLength !== reference.sizeBytes ||
    bytes.byteLength > mediaPreviewLimit(reference.kind)
  )
    throw new Error("媒体大小与登记内容不符或超过预览上限。");
  const actual = inspectMediaBytes(bytes);
  if (!actual || actual.kind !== reference.kind || actual.mimeType !== reference.mimeType)
    throw new Error("文件内容与声明格式不符，已拒绝预览。");
  if (!/^[a-f0-9]{64}$/.test(reference.digest)) throw new Error("媒体缺少有效内容校验值。");
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== reference.digest) throw new Error("媒体内容校验失败，请重新载入。");
  return actual.mimeType;
}

export async function loadMediaBytes(
  runtime: DesktopRuntimeApi,
  scope: MediaScope,
  reference: RuntimeMediaReference,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes <= 0 ||
    reference.sizeBytes > mediaPreviewLimit(reference.kind)
  )
    throw new Error("媒体超过内嵌预览上限，请另存后查看。");
  const metadata = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
    ...scope,
    action: "get",
    artifactId: reference.artifactId,
  });
  signal.throwIfAborted();
  const artifacts = metadata["artifacts"];
  if (!Array.isArray(artifacts) || artifacts.length !== 1)
    throw new Error("媒体已不在当前会话中。");
  const artifact = artifacts[0];
  if (
    !artifact ||
    typeof artifact !== "object" ||
    Array.isArray(artifact) ||
    artifact["artifactId"] !== reference.artifactId ||
    artifact["sizeBytes"] !== reference.sizeBytes ||
    artifact["digest"] !== reference.digest ||
    artifact["mimeType"] !== reference.mimeType
  )
    throw new Error("媒体登记信息已改变，请重新载入。");
  const matches = (value: unknown) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "artifactId" in value &&
    value.artifactId === reference.artifactId &&
    "sizeBytes" in value &&
    value.sizeBytes === reference.sizeBytes &&
    "digest" in value &&
    value.digest === reference.digest &&
    "mimeType" in value &&
    value.mimeType === reference.mimeType;
  const bytes = new Uint8Array(reference.sizeBytes);
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const limit = Math.min(32 * 1024, bytes.length - offset);
    const chunk = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
      ...scope,
      action: "read_chunk",
      artifactId: reference.artifactId,
      offsetBytes: offset,
      limitBytes: limit,
    });
    signal.throwIfAborted();
    if (!matches(chunk["artifact"])) throw new Error("媒体分块的登记信息不符。");
    const base64 = chunk["contentBase64"];
    if (
      typeof base64 !== "string" ||
      base64.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
    )
      throw new Error("媒体分块不是有效 Base64。");
    const decoded = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const end = offset + decoded.length;
    if (
      chunk["offsetBytes"] !== offset ||
      chunk["endOffsetBytes"] !== end ||
      chunk["totalBytes"] !== bytes.length ||
      decoded.length === 0 ||
      decoded.length > limit ||
      end > bytes.length ||
      typeof chunk["truncated"] !== "boolean" ||
      (end < bytes.length
        ? chunk["truncated"] !== true || chunk["nextOffsetBytes"] !== end
        : chunk["truncated"] !== false || chunk["nextOffsetBytes"] !== undefined)
    )
      throw new Error("媒体分块不连续或总长度发生变化。");
    bytes.set(decoded, offset);
    offset = end;
  }
  await validateMediaPayload(bytes, reference);
  signal.throwIfAborted();
  return bytes;
}

export function MediaPreview({
  reference,
  bytes: suppliedBytes,
  onSave,
}: {
  reference: RuntimeMediaReference;
  bytes?: Uint8Array | undefined;
  onSave?: (() => void) | undefined;
}) {
  const context = useContext(MediaContext);
  const scope = context?.scope;
  const previewRef = useRef<HTMLSpanElement>(null);
  const [visibleKey, setVisibleKey] = useState<string>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>();
  const [expanded, setExpanded] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const key = JSON.stringify([
    scope?.workspacePath,
    scope?.sessionId,
    reference.artifactId,
    reference.digest,
    reference.sizeBytes,
    reference.mimeType,
    reference.kind,
  ]);
  const current = state?.key === key ? state : undefined;
  const visible = !!suppliedBytes || visibleKey === key;
  useEffect(() => {
    const element = previewRef.current;
    if (!element || suppliedBytes || !scope) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleKey(key);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [key, suppliedBytes]);
  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    setState(undefined);
    setExpanded(false);
    setSaveError(undefined);
    if (!suppliedBytes && (!context || !visible)) return;
    void (async () => {
      try {
        const bytes = suppliedBytes ?? (await context!.load(reference, abort.signal));
        const mime = suppliedBytes
          ? await validateMediaPayload(bytes, reference)
          : inspectMediaBytes(bytes)!.mimeType;
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
        setState({ key, url });
      } catch (cause) {
        if (!abort.signal.aborted)
          setState({ key, error: cause instanceof Error ? cause.message : "媒体读取失败。" });
      }
    })();
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, suppliedBytes, visible]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
    };
  }, [current?.url]);
  useEffect(() => {
    if (expanded) dialogRef.current?.showModal();
    else if (dialogRef.current?.open) {
      dialogRef.current.close();
      buttonRef.current?.focus();
    }
  }, [expanded]);
  const save =
    onSave ??
    (scope
      ? () => {
          void window.pico.artifacts
            .saveAs({ ...scope, artifactId: reference.artifactId })
            .then((result) => {
              if (!result.ok) setSaveError(result.error.message);
            })
            .catch(() => setSaveError("另存失败，请重试。"));
        }
      : undefined);
  if (!scope && !suppliedBytes)
    return (
      <span className="desktop-markdown__image-placeholder">
        [{reference.kind === "image" ? "图片" : "视频"}：{reference.alt}]
      </span>
    );
  return (
    <span ref={previewRef} className="conversation-media" data-media-id={reference.artifactId}>
      {current?.error ? (
        <span role="alert" className="conversation-media__error">
          {current.error}
        </span>
      ) : !current?.url ? (
        <span role="status">
          {visible ? "正在读取" : "预览"}
          {reference.kind === "image" ? "图片" : "视频"}
          {visible ? "…" : ""}
        </span>
      ) : reference.kind === "video" ? (
        <video
          ref={videoRef}
          src={current.url}
          controls
          preload="metadata"
          aria-label={reference.alt || "视频预览"}
          onError={() => setState({ key, error: "视频格式或编码不受支持，请另存后查看。" })}
        />
      ) : (
        <>
          <button
            ref={buttonRef}
            type="button"
            className="conversation-media__image-button"
            aria-label={`放大图片：${reference.alt}`}
            onClick={() => setExpanded(true)}
          >
            <img
              src={current.url}
              alt={reference.alt}
              onError={() => setState({ key, error: "图片解码失败，请另存后查看。" })}
            />
          </button>
          {expanded &&
            createPortal(
              <dialog
                ref={dialogRef}
                className="conversation-media__dialog"
                aria-label={reference.alt || "图片预览"}
                onCancel={() => setExpanded(false)}
                onClick={(event) => {
                  if (event.target === event.currentTarget) setExpanded(false);
                }}
              >
                <button type="button" aria-label="关闭图片预览" onClick={() => setExpanded(false)}>
                  关闭
                </button>
                <img src={current.url} alt={reference.alt} />
              </dialog>,
              document.body,
            )}
        </>
      )}
      {save && (
        <button className="conversation-media__save" type="button" onClick={save}>
          另存为
        </button>
      )}
      {saveError && <span role="alert">{saveError}</span>}
    </span>
  );
}
