import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { TextField } from "../ui-controls.js";
import { Archive, Code2, Folder, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useArchiveUndo } from "../archive-undo.js";
import { Button, EmptyState, StatusPill } from "../components.js";
import type { SessionView } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import { formatRelative, isTerminalRun } from "../view-format.js";
import {
  SESSION_ARCHIVE_RUNNING_HINT,
  newSessionHref,
  sessionHref,
  workspaceDisplayName,
  workspaceName,
  workspaceSessionKey,
  workspacePathFromSearch,
} from "../workspace-session.js";

export function SessionsPage() {
  const { data, actions, busy } = useRuntime();
  const { offerArchiveUndo } = useArchiveUndo();
  const workspacePath = workspacePathFromSearch(useLocation().search);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const sessions = data.sessions.filter(
    (item) =>
      (!workspacePath || item.workspacePath === workspacePath) &&
      (showArchived || item.status !== "archived") &&
      `${item.title} ${workspaceName(item.workspacePath)} ${item.workspacePath}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const toggleArchive = async (session: SessionView, archived: boolean) => {
    const ref = { workspacePath: session.workspacePath, sessionId: session.id };
    const changed = await actions.setSessionArchived(ref, !archived);
    if (changed && !archived) offerArchiveUndo([ref], `「${session.title}」`);
  };
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">本地记录</span>
          <h2>会话工作库</h2>
          <p>每个会话保留任务上下文、运行记录和检查点。</p>
        </div>
        <Link className="button button--primary" to={newSessionHref()}>
          <Plus aria-hidden="true" size={16} />
          新任务
        </Link>
      </section>
      {workspacePath && (
        <p>
          当前项目：{workspaceName(workspacePath)} · <Link to="/sessions">查看全部项目</Link>
        </p>
      )}
      <div className="toolbar">
        <div className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <TextField
            label="搜索会话"
            name="session-search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话…"
          />
        </div>
        <CheckboxInput
          className="check-control"
          label="显示已归档"
          value={showArchived}
          onChange={setShowArchived}
        />
      </div>
      <section className="panel">
        {sessions.length === 0 ? (
          <EmptyState title="没有匹配的会话" detail="尝试其他关键词，或显示已归档会话。" />
        ) : (
          <div className="session-list">
            {sessions.map((session) => {
              const archived = session.status === "archived";
              const running =
                !archived &&
                data.runs.some(
                  (run) =>
                    run.workspacePath === session.workspacePath &&
                    run.sessionId === session.id &&
                    !isTerminalRun(run.status),
                );
              return (
                <SessionRow
                  key={workspaceSessionKey({
                    workspacePath: session.workspacePath,
                    sessionId: session.id,
                  })}
                  session={session}
                  action={
                    <span className="session-row-action__stack">
                      <Button
                        variant="quiet"
                        disabled={busy === "session-state" || running}
                        title={running ? SESSION_ARCHIVE_RUNNING_HINT : undefined}
                        onClick={() => void toggleArchive(session, archived)}
                      >
                        {archived ? "恢复" : "归档"}
                      </Button>
                      {running && (
                        <small className="session-row-action__hint">
                          {SESSION_ARCHIVE_RUNNING_HINT}
                        </small>
                      )}
                    </span>
                  }
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export function SessionRow({
  session,
  action,
}: {
  readonly session: SessionView;
  readonly action?: ReactNode;
}) {
  const { data } = useRuntime();
  const workspace = data.workspaces.find((candidate) => candidate.path === session.workspacePath);
  return (
    <div className="session-row-wrap">
      <Link
        className="session-row"
        to={sessionHref({ workspacePath: session.workspacePath, sessionId: session.id })}
      >
        <span className="session-row__icon">
          {session.status === "archived" ? (
            <Archive aria-hidden="true" />
          ) : (
            <Code2 aria-hidden="true" />
          )}
        </span>
        <div>
          <div className="row-title">
            <h3>{session.title}</h3>
            <StatusPill status={session.status} />
          </div>
          {session.summary && <p>{session.summary}</p>}
          <div className="session-row__meta">
            <span>
              <Folder aria-hidden="true" />
              {workspaceDisplayName(session.workspacePath, workspace)}
            </span>
            <time>{formatRelative(session.updatedAt)}</time>
          </div>
        </div>
      </Link>
      {action && <div className="session-row-action">{action}</div>}
    </div>
  );
}
