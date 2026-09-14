import {
  createSessionHookRuntime as createHostSessionHookRuntime,
  type SessionHookRuntime as HostSessionHookRuntime,
  type SessionHookRuntimeOptions as HostSessionHookRuntimeOptions,
} from "@pico/pico-host/hooks/runtime";
import type { SlashCommand } from "../input/types.js";
import { logger } from "../observability/logger.js";
import { createHookManagementCommands } from "./management/commands.js";

export type SessionHookRuntimeOptions = Omit<
  HostSessionHookRuntimeOptions<SlashCommand>,
  "logger" | "commandFactory"
>;
export type SessionHookRuntime = HostSessionHookRuntime<SlashCommand>;

export async function createSessionHookRuntime(
  options: SessionHookRuntimeOptions,
): Promise<SessionHookRuntime> {
  return await createHostSessionHookRuntime({
    ...options,
    logger,
    commandFactory: createHookManagementCommands,
  });
}

export type {
  HookManagementCommandFactoryInput,
  HookRuntimeBinding,
  HookRuntimeLogger,
  HookRuntimeSnapshot,
} from "@pico/pico-host/hooks/runtime";
