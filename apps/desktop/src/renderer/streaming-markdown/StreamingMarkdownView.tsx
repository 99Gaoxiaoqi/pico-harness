/**
 * `<StreamingMarkdownView source={...} />`
 *
 * Renders a `StreamingMarkdownSource` with block-level memoization and a
 * throttled visible update (default 50ms). Completed blocks keep their React
 * key and HTML, so appending to the tail never re-renders earlier content.
 */
import React, { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { IncrementalMarkdownRenderer } from "./incremental.js";
import { StreamingMarkdownSource, type StreamingMarkdownSnapshot } from "./source.js";
import { VisibleUpdateScheduler } from "./throttle.js";

// Node integration tests use the classic JSX transform.
void React;

/** Default visible-update interval from the reference streaming implementation. */
export const DEFAULT_VISIBLE_UPDATE_MS = 50;

export function resolveVisibleUpdateMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_VISIBLE_UPDATE_MS;
  return Math.max(0, value);
}

export interface StreamingMarkdownViewProps {
  readonly source: StreamingMarkdownSource;
  /** Visible-update interval in milliseconds; 50 by default, 50-120 recommended. */
  readonly throttleMs?: number | undefined;
  readonly className?: string | undefined;
}

export function StreamingMarkdownView({
  source,
  throttleMs,
  className,
}: StreamingMarkdownViewProps) {
  const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  const visible = useVisibleSnapshot(source, snapshot, resolveVisibleUpdateMs(throttleMs));
  const rendererRef = useRef<IncrementalMarkdownRenderer | null>(null);
  rendererRef.current ??= new IncrementalMarkdownRenderer();
  const renderer = rendererRef.current;
  const blocks = useMemo(
    () => renderer.update(visible.text, visible.finished),
    [renderer, visible],
  );

  const classes = className ? `streaming-markdown ${className}` : "streaming-markdown";
  return (
    <div className={classes} data-streaming={visible.finished ? "finished" : "active"}>
      {blocks.map((block) => (
        <MarkdownBlockView key={block.key} html={block.html} />
      ))}
    </div>
  );
}

const MarkdownBlockView = memo(function MarkdownBlockView({ html }: { readonly html: string }) {
  return <div className="streaming-markdown__block" dangerouslySetInnerHTML={{ __html: html }} />;
});

interface VisibleSnapshot {
  readonly source: StreamingMarkdownSource;
  readonly snapshot: StreamingMarkdownSnapshot;
}

function useVisibleSnapshot(
  source: StreamingMarkdownSource,
  snapshot: StreamingMarkdownSnapshot,
  delayMs: number,
): StreamingMarkdownSnapshot {
  const [visible, setVisible] = useState<VisibleSnapshot>(() => ({ source, snapshot }));
  const latest = useRef<VisibleSnapshot>({ source, snapshot });
  latest.current = { source, snapshot };
  const scheduler = useMemo(() => new VisibleUpdateScheduler(delayMs), [delayMs]);

  useEffect(() => {
    if (visible.source !== source) {
      scheduler.cancel();
      setVisible({ source, snapshot });
      return;
    }
    if (snapshot === visible.snapshot) return;
    if (snapshot.finished) {
      scheduler.cancel();
      setVisible({ source, snapshot });
      return;
    }
    scheduler.request(() => setVisible(latest.current));
  }, [scheduler, snapshot, source, visible]);

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  return visible.source === source ? visible.snapshot : snapshot;
}
