// 兼容旧的 Storage 导入路径；实现已收敛到 @pico/storage。
export {
  coordinateEventLogHardCut,
  EventLogHardCutBlockedError,
  EventLogHardCutIncompatibleEpochError,
  listEventLogBlobGcIntents,
} from "@pico/storage";
export type {
  EventLogBlobGcAssetScope,
  EventLogBlobGcIntent,
  EventLogBlobGcIntentState,
  EventLogEpochMarker,
  EventLogHardCutBlocker,
  EventLogHardCutBlockerKind,
  EventLogHardCutOptions,
  EventLogHardCutResult,
} from "@pico/storage";
