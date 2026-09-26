import { Dialog } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowUpRight, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
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
  const descriptionId = useId();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
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
    <Dialog
      isOpen={open}
      onOpenChange={onOpenChange}
      className="task-search pico-task-search"
      aria-label="搜索任务"
      aria-describedby={descriptionId}
      purpose="info"
      padding={0}
      width="min(580px, calc(100vw - 48px))"
      position={{ top: "18%" }}
    >
      <p id={descriptionId} className="conversation-sr-only">
        按任务标题或项目名称查找，按 Tab 选择结果。
      </p>
      <div className="task-search__input">
        <Search aria-hidden="true" />
        <TextInput
          label="搜索任务标题或项目"
          isLabelHidden
          hasAutoFocus
          className="pico-task-search-field"
          placeholder="搜索任务或项目…"
          value={query}
          onChange={setQuery}
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
        <Button
          label="关闭搜索"
          variant="ghost"
          className="task-search__close"
          onClick={() => onOpenChange(false)}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="task-search__results" aria-label="搜索结果">
        <p role="status">{query ? `${results.length} 个结果` : "最近的任务"}</p>
        {results.length ? (
          results.map((session) => (
            <Button
              label={session.title}
              variant="ghost"
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
            </Button>
          ))
        ) : (
          <div className="task-search__empty">
            {query ? "没有匹配的任务，试试其他关键词。" : "发送第一条消息后，就能在这里找到任务。"}
          </div>
        )}
      </div>
    </Dialog>
  );
}
