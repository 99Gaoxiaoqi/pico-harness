import { X } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface ConversationInspectorProps {
  readonly open: boolean;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode | undefined;
}

export function ConversationInspector({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: ConversationInspectorProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previousFocusRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  };

  return (
    <aside
      ref={panelRef}
      className="conversation-inspector"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
    >
      <header className="conversation-inspector__header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="conversation-icon-button"
          aria-label="关闭详情"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="conversation-inspector__body">{children}</div>
      {footer && <footer className="conversation-inspector__footer">{footer}</footer>}
    </aside>
  );
}
