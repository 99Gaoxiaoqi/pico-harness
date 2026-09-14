import { createHash } from "node:crypto";
import type { Message } from "./message.js";

/** 内容哈希 digest 的当前版本前缀。 */
export const CONTENT_DIGEST_V1_PREFIX = "sha256-content:v1:";

/** covered 事件条目:用于内容哈希的最小结构。 */
export interface CheckpointDigestEntry {
  readonly eventId: string;
  readonly message: Message;
}

/**
 * 计算 checkpoint 的内容哈希 digest。
 *
 * 每个事件的 eventId 与消息全内容均参与哈希；字节长度前缀防止前缀碰撞，
 * 使用字节而非字符长度以覆盖多字节字符。此函数只定义持久事实的校验规则，
 * 不承担任何压缩、存储或宿主职责。
 */
export function computeCheckpointSourceDigest(entries: readonly CheckpointDigestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    const eventIdBytes = Buffer.byteLength(entry.eventId, "utf8");
    const body = JSON.stringify(entry.message);
    const bodyBytes = Buffer.byteLength(body, "utf8");
    hash.update(String(eventIdBytes)).update(":").update(entry.eventId).update("\0");
    hash.update(String(bodyBytes)).update(":").update(body).update(";");
  }
  return CONTENT_DIGEST_V1_PREFIX + hash.digest("hex");
}
