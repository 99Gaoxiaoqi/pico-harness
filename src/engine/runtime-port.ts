import type {
  RuntimeCheckpointInput,
  RuntimeHistoryEntry,
  RuntimeLastCompactionCheckpoint,
  RuntimePort,
  RuntimeReconcileOptions,
  RuntimeRepairProjectionOptions,
  RuntimeRunPort,
  RuntimeRunStartOptions,
  RuntimeToolResultInput,
} from "@pico/runtime/runtime-port-contract";
import type {
  Registry,
  ToolExecutionContext,
  ToolRecoveryProbeResult,
} from "@pico/pico-host/tool-registry-contract";
import type { Session } from "./session.js";

/**
 * Engine compatibility view of the Runtime execution port.
 *
 * The generic, Engine-independent contract belongs to `@pico/runtime`; this
 * file only binds it to Pico's concrete Session and tool interfaces so legacy
 * source imports remain stable during the package migration.
 */
export {
  assertIssuedEngineRuntimeCapability,
  createEngineRuntimeCapability,
} from "@pico/runtime/runtime-capability";
export type {
  EngineRuntimeAuthority,
  EngineRuntimeCapability,
  EngineRuntimeCapabilityInput,
  EngineRuntimeWriteGuard,
} from "@pico/runtime/runtime-capability";
export type {
  RuntimeEvidenceReference as EngineRuntimeEvidenceReference,
  RuntimeToolResultBody as EngineRuntimeToolResultBody,
  RuntimeToolResultProjection as EngineRuntimeToolResultProjection,
  RuntimeToolResultStatus as EngineRuntimeToolResultStatus,
} from "@pico/core";

export type EngineRuntimeHistoryEntry = RuntimeHistoryEntry;
export type EngineRuntimeToolResultInput = RuntimeToolResultInput;
export type EngineRuntimeCheckpointInput = RuntimeCheckpointInput;
export type LastCompactionCheckpoint = RuntimeLastCompactionCheckpoint;
export type EngineRuntimeRun = RuntimeRunPort<
  Session,
  Registry,
  ToolExecutionContext,
  ToolRecoveryProbeResult
>;
export type EngineRuntimeRunStartOptions = RuntimeRunStartOptions;
export type EngineRuntimeReconcileOptions = RuntimeReconcileOptions;
export type EngineRuntimeRepairProjectionOptions = RuntimeRepairProjectionOptions;
export type EngineRuntimePort = RuntimePort<
  Session,
  Registry,
  ToolExecutionContext,
  ToolRecoveryProbeResult
>;
