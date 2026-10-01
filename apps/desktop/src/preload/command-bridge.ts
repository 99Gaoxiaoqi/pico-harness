import type { DesktopCommandsApi } from "./command-contract.js";
import { DESKTOP_COMMAND_CHANNEL } from "./command-contract.js";

export function createCommandBridge(ipc: {
  invoke(channel: string, value: unknown): Promise<unknown>;
}): DesktopCommandsApi {
  // Fixed channel and operations; never expose a generic main-process evaluator.
  return Object.freeze({
    catalog: (context) => ipc.invoke(DESKTOP_COMMAND_CHANNEL, { ...context, operation: "catalog" }),
    complete: (context, text) =>
      ipc.invoke(DESKTOP_COMMAND_CHANNEL, { ...context, operation: "complete", text }),
    execute: (context, text, requestId) =>
      ipc.invoke(DESKTOP_COMMAND_CHANNEL, { ...context, operation: "execute", text, requestId }),
  } as DesktopCommandsApi);
}
