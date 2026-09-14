import { Compactor as RuntimeCompactor, type CompactorOptions } from "@pico/runtime/compactor";
import { logger } from "../observability/logger.js";

export {
  ContextCompactionError,
  makeToolResultSummary,
  sanitizeToolPairs,
} from "@pico/runtime/compactor";
export type {
  CompactorLogger,
  CompactorOptions,
  ToolResultMetaEntry,
} from "@pico/runtime/compactor";

/**
 * Engine compatibility adapter for Runtime's context compaction policy.
 *
 * Existing construction keeps structured product logging; reusable Runtime
 * consumers may instantiate the package implementation without a logger.
 */
export class Compactor extends RuntimeCompactor {
  constructor(options: CompactorOptions) {
    super({ ...options, logger });
  }
}
