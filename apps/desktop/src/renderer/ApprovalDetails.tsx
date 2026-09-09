import type { ApprovalSessionScopeView } from "@pico/protocol";
import type { ApprovalView } from "./model.js";

export function approvalActionTitle(approval: ApprovalView): string {
  switch (approval.toolName) {
    case "write_file":
      return "写入文件";
    case "edit_file":
      return "修改文件";
    case "read_file":
      return "读取文件";
    case "bash":
      return "运行命令";
    default:
      return approval.title;
  }
}

export function approvalScopeLabel(scope: ApprovalSessionScopeView): string {
  switch (scope.type) {
    case "all-edits":
      return "自动允许文件修改";
    case "directories":
      return "加入任务授权目录";
    case "file":
      return scope.access === "read" ? "允许读取此文件" : "允许修改此文件";
    case "bash-command":
      return scope.match === "exact" ? "允许此命令" : "允许此前缀的命令";
    case "tool":
      return `允许 ${scope.toolName} 工具`;
  }
}

function ScopeDescription({ scope }: { readonly scope: ApprovalSessionScopeView }) {
  switch (scope.type) {
    case "all-edits":
      return <p>选择自动允许后，权限切换为“自动”；本任务普通修改免审批，敏感操作仍需确认。</p>;
    case "directories":
      return (
        <>
          <p>{scope.access === "read" ? "读取" : "修改"} · 加入任务授权目录 · 本任务有效</p>
          <pre>{scope.directories.join("\n")}</pre>
          {scope.enableAutoEdits && (
            <p>选择加入授权目录后，权限切换为“自动”；本任务普通修改免审批，敏感操作仍需确认。</p>
          )}
        </>
      );
    case "file":
      return (
        <>
          <p>{scope.access === "read" ? "读取" : "修改"} · 仅此文件 · 本任务有效</p>
          <pre>{scope.path}</pre>
        </>
      );
    case "bash-command":
      return (
        <>
          <p>
            {scope.match === "exact" ? "执行 · 仅匹配此命令" : "执行 · 允许所有匹配此前缀的命令"} ·
            本任务有效
          </p>
          <pre>{scope.command}</pre>
        </>
      );
    case "tool":
      return (
        <>
          <p>本任务后续调用此工具将自动允许。</p>
          <pre>{scope.toolName}</pre>
        </>
      );
  }
}

function operationPreview(approval: ApprovalView): { label: string; text: string | undefined } {
  const fallback = {
    label:
      approval.toolName === "bash"
        ? "命令"
        : ["write_file", "edit_file", "read_file"].includes(approval.toolName ?? "")
          ? "路径"
          : "操作内容",
    text: approval.command,
  };
  if (!approval.command) return fallback;
  try {
    const args: unknown = JSON.parse(approval.command);
    if (!args || typeof args !== "object" || Array.isArray(args)) return fallback;
    const fields = args as Record<string, unknown>;
    const key =
      approval.toolName === "bash"
        ? "command"
        : ["write_file", "edit_file", "read_file"].includes(approval.toolName ?? "")
          ? "path"
          : undefined;
    if (key && typeof fields[key] === "string") {
      return { label: key === "path" ? "路径" : "命令", text: fields[key] };
    }
  } catch {
    /* Commands and legacy previews need not be JSON. */
  }
  return fallback;
}

export function ApprovalDetails({ approval }: { readonly approval: ApprovalView }) {
  const operation = operationPreview(approval);
  return (
    <div className="approval-details">
      {approval.command && (
        <div className="approval-details__target" aria-label={operation.label}>
          <code>{operation.text}</code>
        </div>
      )}
      {approval.diff !== undefined && (
        <details className="approval-details__section">
          <summary>查看修改</summary>
          <pre className="approval-details__diff" aria-label="文件变更预览">
            {approval.diff.split("\n").map((line, index) => (
              <span
                key={index}
                className={
                  line.startsWith("+")
                    ? "is-added"
                    : line.startsWith("-")
                      ? "is-removed"
                      : undefined
                }
              >
                {line}
                {"\n"}
              </span>
            ))}
          </pre>
          {approval.toolName === "bash" && <p>此预览表示写入意图，实际结果由命令执行决定。</p>}
        </details>
      )}
      {approval.sessionScope && (
        <div className="approval-details__scope">
          <ScopeDescription scope={approval.sessionScope} />
        </div>
      )}
      <details className="approval-details__technical">
        <summary>技术详情</summary>
        {operation.text !== approval.command && (
          <pre aria-label="完整工具参数">{approval.command}</pre>
        )}
        {approval.toolName && (
          <p>
            工具：<code>{approval.toolName}</code>
          </p>
        )}
        <p>
          审批 ID：<code>{approval.id}</code>
        </p>
        {approval.providerCallId && (
          <p>
            调用 ID：<code>{approval.providerCallId}</code>
          </p>
        )}
      </details>
    </div>
  );
}
