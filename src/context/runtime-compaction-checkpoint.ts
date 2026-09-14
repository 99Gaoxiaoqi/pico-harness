import {
  recordRuntimeCompactionCheckpoint as recordRuntimeCheckpoint,
  type RuntimeCompactionCheckpointOptions as RuntimeCheckpointOptions,
} from "@pico/runtime/runtime-compaction-checkpoint";
import type { Session } from "../engine/session.js";
import { logger } from "../observability/logger.js";

/** @deprecated checkpoint 内容摘要契约已移至 @pico/core。 */
export {
  CONTENT_DIGEST_V1_PREFIX,
  computeCheckpointSourceDigest,
} from "@pico/runtime/runtime-compaction-checkpoint";
export type {
  CheckpointDigestEntry,
  RuntimeCompactionCheckpointLogger,
  RuntimeCompactionCheckpointResult,
  RuntimeCompactionCheckpointRun,
} from "@pico/runtime/runtime-compaction-checkpoint";

/** Engine compatibility view of Runtime's generic checkpoint composition. */
export type RuntimeCompactionCheckpointOptions = Omit<RuntimeCheckpointOptions<Session>, "logger">;

/**
 * Compatibility adapter that keeps Engine's structured logging while the durable
 * checkpoint algorithm lives in Runtime and depends only on narrow session/run ports.
 */
export async function recordRuntimeCompactionCheckpoint(
  options: RuntimeCompactionCheckpointOptions,
) {
  return await recordRuntimeCheckpoint({ ...options, logger });
}
