import {
  FullCompactor as RuntimeFullCompactor,
  type FullCompactorOptions as RuntimeFullCompactorOptions,
} from "@pico/runtime/full-compactor";
import { logger } from "../observability/logger.js";

export {
  enforceSummaryCharLimit,
  MAX_SUMMARY_CHARS,
  wrapFullCompactionSummary,
} from "@pico/runtime/full-compactor";
export type {
  FullCompactionPreview,
  FullCompactionRequest,
  FullCompactorLogger,
  RuntimeFullCompactionHookService,
  RuntimeFullCompactionInMemorySession,
  RuntimeFullCompactionSessionIdentity,
} from "@pico/runtime/full-compactor";

/** Engine compatibility options; structured logging remains owned by the host. */
export type FullCompactorOptions = Omit<RuntimeFullCompactorOptions, "logger">;

/**
 * Engine compatibility adapter for Runtime's provider-backed full compaction policy.
 *
 * Existing callers retain product logging and HookService wiring, while reusable
 * Runtime consumers can construct the package implementation with their own ports.
 */
export class FullCompactor extends RuntimeFullCompactor {
  constructor(options: FullCompactorOptions) {
    super({ ...options, logger });
  }
}
