import { Archive, Code2, Folder, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, StatusPill } from "../components.js";
import type { SessionView } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import { formatRelative } from "../view-format.js";
import {
  newSessionHref,
  sessionHref,
  workspaceDisplayName,
  workspaceName,
  workspaceSessionKey,
} from "../workspace-session.js";

export function SessionsPage() {
  const { data, actions, busy } = useRuntime();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const sessions = data.sessions.filter(
    (item) =>
      (showArchived || item.status !== "archived") &&
      `${item.title} ${workspaceName(item.workspacePath)} ${item.workspacePath}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
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
      <div className="toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input
            name="session-search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话…"
          />
        </label>
        <label className="check-control">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档
        </label>
      </div>
      <section className="panel">
        {sessions.length === 0 ? (
          <EmptyState title="没有匹配的会话" detail="尝试其他关键词，或显示已归档会话。" />
        ) : (
          <div className="session-list">
            {sessions.map((session) => (
              <SessionRow
                key={workspaceSessionKey({
                  workspacePath: session.workspacePath,
                  sessionId: session.id,
                })}
                session={session}
                action={
                  <Button
                    variant="quiet"
                    disabled={busy === "session-state"}
                    onClick={() =>
                      void actions.setSessionArchived(
                        { workspacePath: session.workspacePath, sessionId: session.id },
                        session.status !== "archived",
                      )
                    }
                  >
                    {session.status === "archived" ? "恢复" : "归档"}
                  </Button>
                }
              />
            ))}
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
