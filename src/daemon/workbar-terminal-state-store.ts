// 兼容旧的 daemon 导入路径；新代码应从 @pico/pico-host 导入 Host 状态 Store。
export { FileWorkbarTerminalStateStore, WorkbarTerminalStateStoreError } from "@pico/pico-host";
export type { FileWorkbarTerminalStateStoreOptions } from "@pico/pico-host";
