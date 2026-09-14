/** The executor cannot safely resume a Run that a daemon restart interrupted. */
export const INTERRUPTED_DAEMON_RUN_ERROR =
  "daemon 重启前 Run 未进入终态，当前 executor 无法安全恢复";
