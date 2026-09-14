import {
  TaskHostRuntime as HostTaskHostRuntime,
  type TaskHostRuntimeOptions as HostTaskHostRuntimeOptions,
} from "@pico/pico-host/task-host-runtime";
import { logger } from "../observability/logger.js";

export type TaskHostRuntime = HostTaskHostRuntime;
export type TaskHostRuntimeOptions = Omit<HostTaskHostRuntimeOptions, "logger">;

/** @deprecated TaskHostRuntime 已迁至 Pico Host；此静态工厂仅注入旧宿主日志。 */
export const TaskHostRuntime = {
  create(options: TaskHostRuntimeOptions): Promise<HostTaskHostRuntime> {
    return HostTaskHostRuntime.create({ ...options, logger });
  },
};
