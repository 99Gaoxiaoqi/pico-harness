import { Dialog } from "@astryxdesign/core/Dialog";
import { AlertTriangle } from "lucide-react";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./components.js";
import { TextField } from "./ui-controls.js";
import "./confirm-dialog.css";

export interface ConfirmDialogOptions {
  /** Question shown as the dialog heading. */
  readonly title: string;
  /** Consequence or context for the decision. */
  readonly body?: ReactNode;
  /** Verb on the confirm button, e.g. 「删除」. */
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** `danger` renders a destructive confirm button. */
  readonly tone?: "default" | "danger";
  /** High-risk actions require typing this text before the confirm button enables. */
  readonly requireText?: { readonly text: string; readonly label: string };
}

interface PendingConfirm {
  readonly id: number;
  readonly options: ConfirmDialogOptions;
  readonly resolve: (confirmed: boolean) => void;
}

let nextId = 0;
let queue: readonly PendingConfirm[] = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return queue;
}

/**
 * In-app replacement for `window.confirm`. Resolves once the user decides.
 * Requires a mounted <ConfirmDialogHost /> (rendered once by DesktopApp).
 */
export function requestConfirm(options: ConfirmDialogOptions): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  queue = [...queue, { id: ++nextId, options, resolve }];
  for (const listener of listeners) listener();
  return promise;
}

function settle(confirmed: boolean) {
  const [entry, ...rest] = queue;
  if (!entry) return;
  queue = rest;
  for (const listener of listeners) listener();
  entry.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const pending = useSyncExternalStore(subscribe, getSnapshot);
  const current = pending[0];
  if (!current) return null;
  return <ConfirmDialogContent key={current.id} options={current.options} onSettle={settle} />;
}

function ConfirmDialogContent({
  options,
  onSettle,
}: {
  readonly options: ConfirmDialogOptions;
  readonly onSettle: (confirmed: boolean) => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const [typed, setTyped] = useState("");
  const tone = options.tone ?? "default";
  const requiresTyping = options.requireText !== undefined;
  const canConfirm = !requiresTyping || typed === options.requireText?.text;
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onSettle(false);
      }}
      purpose="info"
      width={460}
      className="dialog confirm-dialog pico-settings-dialog"
      aria-labelledby={titleId}
      aria-describedby={options.body ? bodyId : undefined}
    >
      <h2 id={titleId}>
        {tone === "danger" && <AlertTriangle aria-hidden="true" size={18} />}
        {options.title}
      </h2>
      {options.body && (
        <p id={bodyId} className="confirm-dialog__body">
          {options.body}
        </p>
      )}
      {options.requireText && (
        <div className="confirm-dialog__require">
          <p>{options.requireText.label}</p>
          <TextField
            label={options.requireText.label}
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        </div>
      )}
      <div className="dialog__actions">
        <Button onClick={() => onSettle(false)}>{options.cancelLabel ?? "取消"}</Button>
        <Button
          variant={tone === "danger" ? "danger" : "primary"}
          disabled={!canConfirm}
          onClick={() => onSettle(true)}
        >
          {options.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
