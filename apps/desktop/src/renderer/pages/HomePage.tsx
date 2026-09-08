import { Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { formatElapsed, isTerminalRun } from "../view-format.js";
import {
  newSessionHref,
  sessionHref,
  workspaceHref,
  workspaceSessionKey,
} from "../workspace-session.js";
import { SessionRow } from "./SessionsPage.js";

export function HomePage() {
  const { data } = useRuntime();
  const latestRun = data.runs.find((run) => !isTerminalRun(run.status));
  const recentSessions = [...data.sessions]
    .filter((session) => session.status !== "archived")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 6);
  return (
    <div className="launch-page">
      <section className="launch-hero">
        <span className="brand-mark brand-mark--large" aria-hidden="true">
          P
        </span>
        <span className="eyebrow">LOCAL AGENT WORKBENCH</span>
        <h2>把下一件事交给 Pico</h2>
        <p>选择一个项目，描述你想完成的结果。Pico 会把分析、执行和变更留在同一条任务记录里。</p>
        <div className="launch-hero__actions">
          <Link className="button button--primary" to={newSessionHref()}>
            <Plus aria-hidden="true" size={16} /> 开始新任务
          </Link>
          {data.workspaces.length === 0 ? (
            <Link className="button" to="/onboarding">
              添加项目
            </Link>
          ) : (
            <span>{data.workspaces.length} 个本地项目已连接</span>
          )}
        </div>
      </section>

      <section className="launch-resume" aria-labelledby="launch-resume-title">
        <header>
          <div>
            <span className="eyebrow">继续工作</span>
            <h3 id="launch-resume-title">最近任务</h3>
          </div>
          <Link to="/sessions">查看全部</Link>
        </header>
        {latestRun && (
          <Link
            className="launch-active-run"
            to={
              latestRun.sessionId
                ? sessionHref({
                    workspacePath: latestRun.workspacePath,
                    sessionId: latestRun.sessionId,
                  })
                : workspaceHref(`/task/${latestRun.id}`, latestRun.workspacePath)
            }
          >
            <span className="launch-active-run__pulse" aria-hidden="true" />
            <span>
              <small>正在执行</small>
              <strong>{latestRun.description}</strong>
            </span>
            <time>{formatElapsed(latestRun.startedAt)}</time>
          </Link>
        )}
        {recentSessions.length === 0 ? (
          <EmptyState title="还没有任务" detail="第一个任务会在发送消息后出现在这里。" />
        ) : (
          <div className="session-list session-list--compact launch-session-list">
            {recentSessions.map((session) => (
              <SessionRow
                key={workspaceSessionKey({
                  workspacePath: session.workspacePath,
                  sessionId: session.id,
                })}
                session={session}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
