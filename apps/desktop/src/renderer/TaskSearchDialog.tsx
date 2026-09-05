import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, Search, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { SessionView, WorkspaceView } from "./model.js";
import { sortSidebarTasks } from "./navigation.js";
import { workspaceDisplayName, workspaceSessionKey } from "./workspace-session.js";

export function TaskSearchDialog({
  open,
  onOpenChange,
  sessions,
  workspaces,
  onSelect,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly sessions: readonly SessionView[];
  readonly workspaces: readonly WorkspaceView[];
  readonly onSelect: (session: SessionView) => void;
}) {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sortSidebarTasks(sessions.filter((session) => session.status !== "archived")).filter(
      (session) => {
        const workspace = workspaces.find((item) => item.path === session.workspacePath);
        return `${session.title} ${workspaceDisplayName(session.workspacePath, workspace)}`
          .toLocaleLowerCase()
          .includes(needle);
      },
    );
  }, [query, sessions, workspaces]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay task-search-overlay" />
        <Dialog.Content
          className="task-search"
          onOpenAutoFocus={() => {
            previousFocusRef.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            setQuery("");
            previousFocusRef.current?.focus();
          }}
        >
          <Dialog.Title className="conversation-sr-only">搜索任务</Dialog.Title>
          <Dialog.Description className="conversation-sr-only">
            按任务标题或项目名称查找，按 Tab 选择结果。
          </Dialog.Description>
          <div className="task-search__input">
            <Search aria-hidden="true" />
            <input
              aria-label="搜索任务标题或项目"
              placeholder="搜索任务或项目…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === "Enter" && results[0]) onSelect(results[0]);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  event.currentTarget
                    .closest(".task-search")
                    ?.querySelector<HTMLButtonElement>(".task-search__result")
                    ?.focus();
                }
              }}
            />
            <Dialog.Close className="task-search__close" aria-label="关闭搜索">
              <X aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="task-search__results" aria-label="搜索结果">
            <p role="status">{query ? `${results.length} 个结果` : "最近的任务"}</p>
            {results.length ? (
              results.map((session) => (
                <button
                  key={workspaceSessionKey({
                    workspacePath: session.workspacePath,
                    sessionId: session.id,
                  })}
                  className="task-search__result"
                  onClick={() => onSelect(session)}
                >
                  <span>
                    <strong>{session.title}</strong>
                    <small>
                      {workspaceDisplayName(
                        session.workspacePath,
                        workspaces.find((item) => item.path === session.workspacePath),
                      )}
                    </small>
                  </span>
                  <ArrowUpRight aria-hidden="true" />
                </button>
              ))
            ) : (
              <div className="task-search__empty">
                {query
                  ? "没有匹配的任务，试试其他关键词。"
                  : "发送第一条消息后，就能在这里找到任务。"}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
