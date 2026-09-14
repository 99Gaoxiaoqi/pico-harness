// 兼容旧模块路径；原生搜索能力解析是 Runtime 策略，不依赖 Provider 网络适配器。
export { isOfficialEndpoint, resolveNativeWebSearchCapability } from "@pico/runtime";
export type { NativeWebSearchCapability } from "@pico/core";
