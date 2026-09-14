// 兼容旧模块路径；Provider 错误出口装饰器由 @pico/runtime 持有。
export {
  redactProviderError,
  redactProviderErrorText,
  withProviderErrorRedaction,
} from "@pico/runtime";
