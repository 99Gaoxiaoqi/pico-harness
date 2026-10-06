export class GatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly retryable = false,
    readonly outcome: "not_executed" | "unknown" = "not_executed",
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
export function safeGatewayError(error: unknown, dispatched = false): GatewayError {
  if (error instanceof GatewayError) return error;
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "INTERNAL_ERROR";
  const allowed: Record<string, [string, number, boolean]> = {
    INVALID_REQUEST: ["请求格式或方法无效", 400, false],
    VERSION_MISMATCH: ["远程协议版本不兼容", 409, false],
    FRAME_TOO_LARGE: ["请求超过预算", 413, false],
    INVALID_PARAMS: ["请求参数无效", 400, false],
    METHOD_NOT_FOUND: ["该能力不支持远程访问", 403, false],
    FORBIDDEN: ["宿主拒绝此操作或能力不可用", 403, false],
    NOT_FOUND: ["资源不存在或不属于授权范围", 404, false],
    CONFLICT: ["资源已更新，请刷新后重试", 409, false],
    RESET_REQUIRED: ["历史版本发生变化，请重新同步", 409, false],
    RUNTIME_UNAVAILABLE: ["电脑 Runtime 暂时不可用", 503, true],
    RUNTIME_DISCONNECTED: ["电脑 Runtime 连接中断", 503, true],
    RUNTIME_CLIENT_CLOSED: ["电脑 Runtime 连接已关闭", 503, true],
    RUNTIME_REQUEST_TIMEOUT: ["请求等待超时；操作可能仍在执行", 504, false],
    SEND_RECOVERY_UNAVAILABLE: ["无法确认原发送结果，请查看会话后再决定是否重新发送", 409, false],
    MCP_CONFIG_REVISION_CONFLICT: ["MCP 配置已更新，请刷新", 409, false],
  };
  const detail = allowed[code];
  return new GatewayError(
    detail ? code : "INTERNAL_ERROR",
    detail?.[0] ?? "网关处理失败，请查看电脑本机诊断",
    detail?.[1] ?? 500,
    detail?.[2] ?? false,
    dispatched ? "unknown" : "not_executed",
  );
}
