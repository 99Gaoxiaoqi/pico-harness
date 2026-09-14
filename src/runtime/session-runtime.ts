import { createSessionRuntime as createHostSessionRuntime, type SessionRuntime as HostSessionRuntime, type SessionRuntimeOptions as HostSessionRuntimeOptions } from "@pico/pico-host/session-runtime";
import type { SlashCommand } from "@pico/cli/command-contracts";
import { createHookManagementCommands } from "@pico/cli/hook-management-commands";
export * from "@pico/pico-host/session-runtime";
export type SessionRuntime = HostSessionRuntime<SlashCommand>;
export type SessionRuntimeOptions = Omit<HostSessionRuntimeOptions<SlashCommand>, "hookCommandFactory">;
export function createSessionRuntime(options: SessionRuntimeOptions): Promise<SessionRuntime> {
  return createHostSessionRuntime({ ...options, hookCommandFactory: createHookManagementCommands });
}
