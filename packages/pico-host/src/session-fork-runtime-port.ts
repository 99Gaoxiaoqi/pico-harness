import type { SessionForkModelCheckpoint } from "@pico/core";
export {
  SessionForkPublicationUncertainError,
  SessionForkRuntimeConflictError,
} from "@pico/core/session-fork-contract";
import type {
  RuntimeSessionForkAuthority,
  RuntimeSessionForkBootstrapOptions,
  RuntimeSessionForkBootstrapSeed,
  RuntimeSessionForkPort,
  RuntimeSessionForkPublicationCapability,
  RuntimeSessionForkStateWritePatch,
  RuntimeSessionForkWriteGuard,
} from "@pico/runtime/session-fork-runtime-port";
import type { FileHistoryRewindTransactionHooks } from "@pico/pico-host/file-history-runtime";
import type { Session } from "./session.js";
import type { EngineRuntimeCapability, EngineRuntimePort } from "./engine-runtime-port.js";
import type { RuntimeEvent as CoreRuntimeEvent, DurableTranscriptEvent } from "@pico/core";

type RuntimeEvent = CoreRuntimeEvent<DurableTranscriptEvent>;

/**
 * Engine compatibility view of Runtime's durable fork boundary.
 *
 * Runtime owns the generic protocol contract; Engine only binds it to the
 * concrete Session, RuntimeEvent and filesystem transaction-hook types.
 */
export type SessionForkRuntimeAuthority = RuntimeSessionForkAuthority;
export type SessionForkRuntimeWriteGuard = RuntimeSessionForkWriteGuard;
export type SessionForkRuntimeCapability = EngineRuntimeCapability;
export type { SessionForkModelCheckpoint };
export type SessionForkPublicationCapability = RuntimeSessionForkPublicationCapability;
export type SessionForkRuntimeStateWritePatch = RuntimeSessionForkStateWritePatch;
export type SessionForkBootstrapSeed = RuntimeSessionForkBootstrapSeed;
export type SessionForkBootstrapOptions = RuntimeSessionForkBootstrapOptions<RuntimeEvent>;
export type SessionForkRuntimePort = RuntimeSessionForkPort<
  Session,
  EngineRuntimePort,
  RuntimeEvent,
  FileHistoryRewindTransactionHooks
>;
