export type ConnectionIssue = {
  code: string;
  message: string;
  guidance: string;
  action: "reconnect" | "pair" | "authorize" | "update" | "verify" | "prepare" | "none";
};

/** Only structured transport provenance can mark a command outcome unknown. */
export function connectionIssue(error: unknown): ConnectionIssue {
  const value =
    error && typeof error === "object"
      ? (error as {
          code?: unknown;
          message?: unknown;
          outcome?: unknown;
          retryable?: unknown;
          cause?: { code?: unknown };
        })
      : {};
  const code = typeof value.code === "string" ? value.code : "OPERATION_FAILED";
  const message =
    typeof value.message === "string" ? value.message : "操作失败，请查看电脑网关状态";
  const issue = (action: ConnectionIssue["action"], guidance: string) => ({
    code,
    message,
    action,
    guidance,
  });
  if (value.outcome === "unknown")
    return issue(
      "verify",
      "结果未确认。先查看电脑状态；发送和审阅仅使用原恢复记录核对，勿重新提交。终端输入需人工核对。 ",
    );
  if (
    [
      "UNAUTHORIZED",
      "DEVICE_REVOKED",
      "INVALID_AUTH",
      "MISSING_CREDENTIAL",
      "PAIRING_EXPIRED",
    ].includes(code)
  )
    return issue("pair", "在电脑重新生成配对内容并批准。撤销或过期的凭据无法通过重连恢复。 ");
  if (["FORBIDDEN", "PERMISSION_DENIED", "WORKSPACE_FORBIDDEN"].includes(code))
    return issue("authorize", "在电脑调整此设备的项目与操作权限，再连接。 ");
  if (
    [
      "VERSION_MISMATCH",
      "GATEWAY_MISMATCH",
      "INCOMPATIBLE_PROTOCOL",
      "RELAY_IDENTITY_ERROR",
    ].includes(code)
  )
    return issue("update", "核对所连接电脑，更新手机与电脑到兼容版本；身份不符时重新配对。 ");
  const causeCode = String(value.cause?.code ?? "");
  if (code === "RELAY_UNAVAILABLE")
    return issue(
      "reconnect",
      "中继或电脑暂不可达。确认电脑在线后重新连接；恢复时只同步状态，不自动重发命令。",
    );
  if (/CERT|TLS|SSL/.test(code + causeCode) || /certificate|证书|SSL/i.test(message))
    return issue("prepare", "检查电脑 HTTPS 证书有效期、域名和完整信任链。手机不会跳过证书校验。 ");
  if (
    ["CONNECTION_FAILED", "REQUEST_TIMEOUT", "TRANSPORT_ERROR"].includes(code) ||
    value.retryable === true ||
    /Network request failed|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)
  )
    return issue(
      "reconnect",
      "检查电脑网关已启动、域名可解析及网络可达。恢复后只同步状态，不自动重发命令。 ",
    );
  return issue("none", "按错误说明处理后继续；可在隐私与支持查看不含凭据的诊断信息。 ");
}
