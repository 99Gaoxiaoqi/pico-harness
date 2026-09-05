import { ArrowDown } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface ConversationSurfaceProps {
  readonly children: ReactNode;
  readonly inspector?: ReactNode | undefined;
  readonly composer?: ReactNode | undefined;
  readonly header?: ReactNode | undefined;
  readonly className?: string | undefined;
  readonly inspectorMode?: "rail" | "panel" | "workbar" | undefined;
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
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const updateFollowState = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    shouldFollowRef.current = distanceFromBottom <= 96;
    setShowScrollToBottom(!shouldFollowRef.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    shouldFollowRef.current = true;
    setShowScrollToBottom(false);
    scroll.scrollTop = scroll.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const observer = new ResizeObserver(() => {
      if (shouldFollowRef.current) scroll.scrollTop = scroll.scrollHeight;
      updateFollowState();
    });
    observer.observe(scroll);
    observer.observe(content);
    return () => observer.disconnect();
  }, [updateFollowState]);

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
      data-has-composer={Boolean(composer) || undefined}
      data-has-header={Boolean(header) || undefined}
      aria-label="Pico 会话"
    >
      <div className="conversation-surface__main">
        {header && <header className="conversation-surface__header">{header}</header>}
        <div className="conversation-surface__viewport">
          <div
            ref={scrollRef}
            className="conversation-surface__scroll"
            role="region"
            aria-label="会话内容"
            tabIndex={0}
            onScroll={updateFollowState}
          >
            <div ref={contentRef} className="conversation-surface__content">
              {children}
            </div>
          </div>
          {showScrollToBottom && (
            <button
              type="button"
              className="conversation-scroll-to-bottom"
              onClick={scrollToBottom}
              aria-label="回到最新消息"
              title="回到最新消息"
            >
              <ArrowDown aria-hidden="true" />
            </button>
          )}
        </div>
        {composer && <div className="conversation-surface__composer">{composer}</div>}
      </div>
      {inspector}
    </section>
  );
}
