import {
  summarizeCacheEffectiveness as summarizeCacheEffectivenessFromRuntime,
  type CacheEffectiveness,
} from "@pico/runtime/cache-effectiveness";
import type { ProviderCallRecord } from "@pico/storage/runtime-control-types";

export type {
  CacheColdStartReason,
  CacheDiagnosticClassification,
  CacheEffectiveness,
  CacheEffectivenessLayer,
  CacheOperationalAlert,
  CacheOperationalAlertKind,
} from "@pico/runtime/cache-effectiveness";

/** @deprecated Cache-effectiveness aggregation now belongs to @pico/runtime. */
export function summarizeCacheEffectiveness(
  records: readonly ProviderCallRecord[],
): CacheEffectiveness {
  return summarizeCacheEffectivenessFromRuntime(records);
}
