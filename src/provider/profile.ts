// 兼容旧模块路径；内置模型 profile 是 Runtime 策略，数据契约由 @pico/core 持有。
export { normalizeModel, resolveProviderProfile } from "@pico/runtime";
export type { AssistantContentMode, ProviderProfile, ProviderProtocol } from "@pico/core";
