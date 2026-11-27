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
  readonly targets: readonly WorkspaceSessionRef[];
  /** Human label following 「已归档」, e.g. 「标题」 or 项目「X」的 3 条聊天. */
  readonly label: string;
}

interface ArchiveUndoApi {
  /** One call, one undo slot: single rows and bulk archives share the offer. */
  readonly offerArchiveUndo: (targets: readonly WorkspaceSessionRef[], label: string) => void;
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

  const offerArchiveUndo = useCallback((targets: readonly WorkspaceSessionRef[], label: string) => {
    window.clearTimeout(timerRef.current);
    setEntry({ targets, label });
    timerRef.current = window.setTimeout(() => setEntry(undefined), UNDO_WINDOW_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const api = useMemo(() => ({ offerArchiveUndo }), [offerArchiveUndo]);
  const undo = async () => {
    if (!entry || pending) return;
    setPending(true);
    try {
      const restored = await Promise.all(
        entry.targets.map((target) => actions.setSessionArchived(target, false)),
      );
      if (restored.every(Boolean)) {
        actions.showMessage?.("已撤销归档。");
        dismiss();
      } else {
        actions.showMessage?.("撤销未完成，请重试或到会话工作库恢复。", "error");
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
          <span>{`已归档${entry.label}`}</span>
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
