/**
 * 兼容旧 Storage 导入路径。Store 契约归属 @pico/storage；旧入口保留
 * Engine Transcript 的专用类型，避免读取侧出现宽化。
 */
import type { DurableTranscriptEvent } from "@pico/core";
import type {
  PrepareRuntimeToolOperationInput as StoragePrepareRuntimeToolOperationInput,
  RuntimeContinuationStartOutcome as StorageRuntimeContinuationStartOutcome,
  RuntimeEventStoreEntry as StorageRuntimeEventStoreEntry,
  RuntimeSessionProjectionDelta as StorageRuntimeSessionProjectionDelta,
  RuntimeSessionProjectionSnapshot as StorageRuntimeSessionProjectionSnapshot,
  SettleRuntimeToolOperationInput as StorageSettleRuntimeToolOperationInput,
  StartRuntimeContinuationInput as StorageStartRuntimeContinuationInput,
  WorkspaceRuntimeSessionSnapshot as StorageWorkspaceRuntimeSessionSnapshot,
} from "@pico/storage/runtime-event-store-contracts";

export * from "@pico/storage/runtime-event-store-contracts";

export type PrepareRuntimeToolOperationInput =
  StoragePrepareRuntimeToolOperationInput<DurableTranscriptEvent>;
export type SettleRuntimeToolOperationInput =
  StorageSettleRuntimeToolOperationInput<DurableTranscriptEvent>;
export type RuntimeEventStoreEntry = StorageRuntimeEventStoreEntry<DurableTranscriptEvent>;
export type WorkspaceRuntimeSessionSnapshot =
  StorageWorkspaceRuntimeSessionSnapshot<DurableTranscriptEvent>;
export type RuntimeSessionProjectionSnapshot =
  StorageRuntimeSessionProjectionSnapshot<DurableTranscriptEvent>;
export type RuntimeSessionProjectionDelta =
  StorageRuntimeSessionProjectionDelta<DurableTranscriptEvent>;
export type StartRuntimeContinuationInput =
  StorageStartRuntimeContinuationInput<DurableTranscriptEvent>;
export type RuntimeContinuationStartOutcome =
  StorageRuntimeContinuationStartOutcome<DurableTranscriptEvent>;
