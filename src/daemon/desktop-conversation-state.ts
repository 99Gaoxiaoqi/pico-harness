// 兼容旧的 daemon 导入路径；契约已收敛到 @pico/pico-host。
export {
  FIRST_SEND_CLAIM_RETENTION_MS,
  MAX_FIRST_SEND_CLAIMS,
  MAX_IDEMPOTENCY_RECORDS,
  normalizeWorkspacePath,
  parseDesktopQueuedInputRecord,
  requireNonEmpty,
} from "@pico/pico-host";
export type {
  DesktopConversationStateStoreLike,
  DesktopFirstSendClaim,
  DesktopIdempotencyRecord,
  DesktopQueuedInput,
  DesktopRewindClaim,
} from "@pico/pico-host";
