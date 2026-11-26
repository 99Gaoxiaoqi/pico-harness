import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useRuntime } from "./runtime-context.js";
import type { WorkspaceSessionRef } from "./workspace-session.js";

interface ArchiveUndoEntry {
  readonly target: WorkspaceSessionRef;
  readonly title: string;
}

interface ArchiveUndoApi {
  readonly offerArchiveUndo: (target: WorkspaceSessionRef, title: string) => void;
}

const ArchiveUndoContext = createContext<ArchiveUndoApi | undefined>(undefined);

const UNDO_WINDOW_MS = 8000;

/**
 * Shell-level undo slot for reversible actions. Archiving a session is
 * undoable, so it must not block the user with a confirm dialog; the offer
 * lives here instead of the Runtime toast because it carries an action.
 */
export function ArchiveUndoProvider({ children }: { readonly children: ReactNode }) {
  const { actions, message } = useRuntime();
  const [entry, setEntry] = useState<ArchiveUndoEntry>();
  const [pending, setPending] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setEntry(undefined);
  }, []);

  const offerArchiveUndo = useCallback((target: WorkspaceSessionRef, title: string) => {
    window.clearTimeout(timerRef.current);
    setEntry({ target, title });
    timerRef.current = window.setTimeout(() => setEntry(undefined), UNDO_WINDOW_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const api = useMemo(() => ({ offerArchiveUndo }), [offerArchiveUndo]);
  const undo = async () => {
    if (!entry || pending) return;
    setPending(true);
    try {
      if (await actions.setSessionArchived(entry.target, false)) {
        actions.showMessage?.("已撤销归档。");
        dismiss();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <ArchiveUndoContext.Provider value={api}>
      {children}
      {entry && (
        <div
          className={`toast toast--archive-undo ${message ? "toast--raised" : ""}`}
          role="status"
        >
          <span>{`已归档「${entry.title}」`}</span>
          <button
            type="button"
            className="toast__action"
            disabled={pending}
            onClick={() => void undo()}
          >
            {pending ? "正在撤销…" : "撤销"}
          </button>
          <button type="button" className="toast__dismiss" aria-label="关闭提示" onClick={dismiss}>
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      )}
    </ArchiveUndoContext.Provider>
  );
}

export function useArchiveUndo(): ArchiveUndoApi {
  const value = useContext(ArchiveUndoContext);
  if (!value) throw new Error("useArchiveUndo must be used inside ArchiveUndoProvider");
  return value;
}
