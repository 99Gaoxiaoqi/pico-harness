import type { ReactNode } from "react";

export interface ConversationSurfaceProps {
  readonly children: ReactNode;
  readonly inspector?: ReactNode | undefined;
  readonly composer?: ReactNode | undefined;
  readonly header?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function ConversationSurface({
  children,
  inspector,
  composer,
  header,
  className = "",
}: ConversationSurfaceProps) {
  return (
    <section
      className={`conversation-surface ${className}`.trim()}
      data-inspector-open={Boolean(inspector) || undefined}
      aria-label="Pico 会话"
    >
      <div className="conversation-surface__main">
        {header && <header className="conversation-surface__header">{header}</header>}
        <div className="conversation-surface__scroll">{children}</div>
        {composer && <div className="conversation-surface__composer">{composer}</div>}
      </div>
      {inspector}
    </section>
  );
}
