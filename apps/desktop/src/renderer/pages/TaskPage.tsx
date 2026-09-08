import { History } from "lucide-react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { EmptyState } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { sessionHref, workspacePathFromSearch } from "../workspace-session.js";

export function TaskPage() {
  const { runId } = useParams();
  const { data } = useRuntime();
  const location = useLocation();
  const workspacePath = workspacePathFromSearch(location.search);
  const run = data.runs.find((item) => item.workspacePath === workspacePath && item.id === runId);
  if (!run)
    return <EmptyState title="找不到这次运行" detail="它可能已被归档，或 Runtime 尚未同步完成。" />;
  if (run.sessionId) {
    return (
      <Navigate
        replace
        to={sessionHref({ workspacePath: run.workspacePath, sessionId: run.sessionId })}
      />
    );
  }
  return (
    <EmptyState
      icon={<History />}
      title="这是旧版运行记录"
      detail="它没有可恢复的 Session 标识。Pico 不会用其他运行的时间线或更改冒充这次记录。"
      action={
        <Link className="button" to="/sessions">
          返回会话库
        </Link>
      }
    />
  );
}
