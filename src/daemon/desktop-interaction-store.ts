// 兼容旧的 daemon 导入路径；新代码应从 @pico/pico-host 导入 Host 状态 Store。
export { DesktopInteractionStoreError, FileDesktopInteractionStore } from "@pico/pico-host";
export type {
  DesktopInteractionRecord,
  DesktopInteractionResolution,
  DesktopInteractionStatus,
  DesktopInteractionStore,
  DesktopInteractionStoreCommitInput,
  DesktopInteractionStoreCommitResult,
  FileDesktopInteractionStoreOptions,
} from "@pico/pico-host";
