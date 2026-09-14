import { logger } from "../observability/logger.js";
import {
  createConfiguredSubagentOutputStore as createHostConfiguredSubagentOutputStore,
  type ConfiguredSubagentOutputStoreOptions as HostConfiguredSubagentOutputStoreOptions,
} from "@pico/pico-host/configured-subagent-output-store";

export * from "@pico/pico-host/configured-subagent-output-store";

/** @deprecated 子代理输出 Store 的宿主装配已迁至 @pico/pico-host。 */
export type ConfiguredSubagentOutputStoreOptions = Omit<
  HostConfiguredSubagentOutputStoreOptions,
  "warningLogger"
>;

/** 保留旧入口的 SQLite 歧义写入诊断。 */
export function createConfiguredSubagentOutputStore(options: ConfiguredSubagentOutputStoreOptions) {
  return createHostConfiguredSubagentOutputStore({ ...options, warningLogger: logger });
}
