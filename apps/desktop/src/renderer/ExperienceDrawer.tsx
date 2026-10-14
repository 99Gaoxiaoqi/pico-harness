import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./components.js";
import "./ExperienceDrawer.css";

/** A local detail surface: the conversation and its composer stay mounted underneath. */
export function ExperienceDrawer({
  title,
  onClose,
  children,
  open = true,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly open?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <dialog
      ref={dialogRef}
      className="experience-drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="experience-drawer__header">
        <h2 id={titleId}>{title}</h2>
        <Button variant="quiet" aria-label="关闭经验详情" onClick={onClose}>
          关闭
        </Button>
      </header>
      <div className="experience-drawer__body">{children}</div>
      <p className="experience-drawer__footer">关闭详情后继续当前任务，不清空任务输入。</p>
    </dialog>
  );
}

export function ExperienceDrawerTrigger({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return (
    <>
      <Button
        variant="quiet"
        aria-haspopup="dialog"
        onClick={() => {
          setVisited(true);
          setOpen(true);
        }}
      >
        {title}
      </Button>
      {visited && (
        <ExperienceDrawer title={title} open={open} onClose={() => setOpen(false)}>
          {children}
        </ExperienceDrawer>
      )}
    </>
  );
}
