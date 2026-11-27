import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RuntimeMediaReference } from "@pico/protocol";
import { StreamingMarkdownSource, StreamingMarkdownView } from "../streaming-markdown/index.js";
import { MarkdownText } from "./MarkdownText.js";

/**
 * 助手/思考文本的流式渲染入口。
 *
 * 文本只追加到 `StreamingMarkdownSource`；视图按块渲染，已完成块以内容哈希为 key
 * 复用上一轮的 HTML，只有尾部未完成块会重新解析，可见更新由模块按 50ms 节流。
 *
 * 仍然走一次性 `MarkdownText` 的两种情况：
 * - 消息带媒体引用或 `pico://` 附件链接：这些需要 MarkdownText 里的 React 媒体/附件组件；
 * - 非流式消息：流结束后由 MarkdownText 做一次权威全量渲染（含媒体、附件与 HTML 预览）。
 */
export interface StreamingMarkdownTextProps {
  readonly text: string;
  readonly streaming: boolean;
  readonly dim?: boolean | undefined;
  readonly media?: readonly RuntimeMediaReference[] | undefined;
  readonly previewHtmlArtifacts?: boolean | undefined;
}

export function StreamingMarkdownText({
  text,
  streaming,
  dim = false,
  media,
  previewHtmlArtifacts = false,
}: StreamingMarkdownTextProps) {
  const rich = (media !== undefined && media.length > 0) || text.includes("pico://");
  const live = streaming && !rich;
  const latestText = useRef(text);
  latestText.current = text;
  const [generation, setGeneration] = useState(0);
  // 重置（编辑回退、压缩重写）时换一个新 source；初值取当前文本，避免闪烁。
  const source = useMemo(() => new StreamingMarkdownSource(latestText.current), [generation]);
  const committed = useRef(text);
  useLayoutEffect(() => {
    const previous = committed.current;
    if (text === previous) return;
    committed.current = text;
    if (text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      if (delta.length > 0) source.append(delta);
      return;
    }
    setGeneration((value) => value + 1);
  }, [source, text]);
  if (!live) {
    return (
      <MarkdownText
        text={text}
        dim={dim}
        media={media}
        previewHtmlArtifacts={previewHtmlArtifacts}
      />
    );
  }
  return (
    <StreamingMarkdownView
      source={source}
      className={dim ? "desktop-markdown desktop-markdown--dim" : "desktop-markdown"}
    />
  );
}
