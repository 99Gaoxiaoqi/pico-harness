import type { RuntimeMethod, RuntimeParams, RuntimeResult } from "@pico/protocol";
import type { CommandSessionRuntime } from "./command-helpers.js";

/** CLI 命令所需的 RPC 与当前会话标识。 */
export interface RpcCommandRuntime extends CommandSessionRuntime {
  request<Method extends RuntimeMethod>(
    method: Method,
    params: RuntimeParams<Method>,
  ): Promise<RuntimeResult<Method>>;
}
