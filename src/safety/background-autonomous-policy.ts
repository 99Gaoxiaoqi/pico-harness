/** @deprecated 后台安全编排已归属 Pico Host；本入口只注入日志。 */
import {
  prepareBackgroundAutonomousPolicy as prepareHostPolicy,
  StrictBackgroundHookRunner as HostHookRunner,
} from "@pico/pico-host/background-autonomous-policy";
import { logger } from "../observability/logger.js";
export * from "@pico/pico-host/background-autonomous-policy";
export function prepareBackgroundAutonomousPolicy(input: Parameters<typeof prepareHostPolicy>[0]) {
  return prepareHostPolicy({ ...input, diagnostics: input.diagnostics ?? logger });
}
export class StrictBackgroundHookRunner extends HostHookRunner {
  constructor(...args: ConstructorParameters<typeof HostHookRunner>) {
    super(args[0], args[1], args[2], args[3] ?? logger);
  }
}
