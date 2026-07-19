import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

export interface ConversationSurfaceProps {
  readonly children: ReactNode;
  readonly inspector?: ReactNode | undefined;
  readonly composer?: ReactNode | undefined;
  readonly header?: ReactNode | undefined;
  readonly className?: string | undefined;
  readonly inspectorMode?: "rail" | "panel" | undefined;
}

export function ConversationSurface({
  children,
  inspector,
  composer,
  header,
  className = "",
  inspectorMode = "rail",
}: ConversationSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);

  const updateFollowState = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    shouldFollowRef.current = distanceFromBottom <= 96;
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !shouldFollowRef.current) return;
    scroll.scrollTop = scroll.scrollHeight;
  }, [children]);

  return (
    <section
      className={`conversation-surface ${className}`.trim()}
      data-inspector-open={Boolean(inspector) || undefined}
      data-inspector-mode={inspector ? inspectorMode : undefined}
      aria-label="Pico 会话"
    >
      <div className="conversation-surface__main">
        {header && <header className="conversation-surface__header">{header}</header>}
        <div
          ref={scrollRef}
          className="conversation-surface__scroll"
          role="region"
          aria-label="会话内容"
          tabIndex={0}
          onScroll={updateFollowState}
        >
          {children}
        </div>
        {composer && <div className="conversation-surface__composer">{composer}</div>}
      </div>
      {inspector}
    </section>
  );
}
