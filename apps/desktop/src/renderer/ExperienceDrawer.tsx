import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "./components.js";
import "./ExperienceDrawer.css";

/** A local detail surface: the conversation and its composer stay mounted underneath. */
export function ExperienceDrawer({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
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
      <p className="experience-drawer__footer">关闭详情后继续当前任务，输入草稿保持不变。</p>
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
  return (
    <>
      <Button variant="quiet" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {title}
      </Button>
      {open && (
        <ExperienceDrawer title={title} onClose={() => setOpen(false)}>
          {children}
        </ExperienceDrawer>
      )}
    </>
  );
}
