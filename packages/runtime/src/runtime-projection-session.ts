import type {
  CanonicalTranscriptToolStart,
  Message,
  RuntimeEventBase,
  SessionRuntimeStateSnapshot,
  SessionUsageSnapshot,
} from "@pico/core";
import type {
  RuntimeEventStoreAppendResult,
  RuntimeOwnerFence,
} from "@pico/storage/runtime-event-store-contracts";
import type { EngineRuntimeCapability } from "./runtime-capability.js";

/**
 * Replaceable in-memory Session projection required by the durable RuntimeRun.
 * Engine owns the concrete Session; Runtime only sees this capability surface.
 */
export interface RuntimeProjectionSession {
  readonly id: string;
  readonly workDir: string;
  readonly runtimeEventCapability: EngineRuntimeCapability | undefined;

  assertRuntimeEventAuthority(authority: object): void;
  assertRuntimeEventWriteAllowed(): Promise<RuntimeOwnerFence>;
  withSerializedExecution<Result>(task: () => Promise<Result>): Promise<Result>;
  getModelContext(): Message[];
  getRuntimeStateSnapshot(): SessionRuntimeStateSnapshot;
  replaceRuntimeProjection(messages: readonly Message[], projectionEventId: string): Promise<void>;
  replaceRuntimeUsage(usage: SessionUsageSnapshot, projectionEventId: string): Promise<void>;
  commitRuntimeProjectionBatch(commits: readonly RuntimeEventStoreAppendResult[]): Promise<void>;
  recordRuntimeTranscriptToolStarts(input: {
    readonly invocationId: string;
    readonly runId: string;
    readonly turnId: string;
    readonly createdAt: number;
    readonly toolCalls: readonly {
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }[];
    readonly refs?: RuntimeEventBase["refs"];
  }): Promise<readonly CanonicalTranscriptToolStart[]>;
}
