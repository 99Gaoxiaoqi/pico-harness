import type { EngineRuntimeHistoryEntry, EngineRuntimePort } from "./engine-runtime-port.js";
import type { RuntimeHistoryProjectionEntry } from "@pico/runtime/session-runtime-read-model";
import { createRuntimeRunPort } from "@pico/runtime/runtime-run-port-adapter";
import type { Session } from "./session.js";
import type { Registry } from "@pico/pico-host/tool-registry-contract";

// Preserve legacy RuntimeRun diagnostics configuration for old Engine callers.
import { configureRuntimeRunDiagnostics } from "@pico/runtime/runtime-run-diagnostics";
import { logger } from "./logger.js";

configureRuntimeRunDiagnostics(logger);

/**
 * Adapts the concrete durable RuntimeRun to the small port consumed by the
 * engine.  All implementation-specific casts are kept here so the engine does
 * not import RuntimeRun, RuntimeEventStore, or the runtime projection module.
 */
export function createEngineRuntimePort(): EngineRuntimePort {
  return createRuntimeRunPort<Session, Registry>();
}

/** Structural assertion used by tests and host assembly. */
export function asEngineRuntimeHistoryEntry(
  entry: RuntimeHistoryProjectionEntry,
): EngineRuntimeHistoryEntry {
  return { eventId: entry.eventId, message: entry.message };
}
