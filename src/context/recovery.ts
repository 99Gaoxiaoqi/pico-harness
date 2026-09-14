/** Compatibility adapter: Runtime owns recovery policy, Context supplies the host shell dialect. */
import { RecoveryManager as RuntimeRecoveryManager } from "@pico/runtime/recovery";
import { hostShellDialect } from "../os/shell.js";

export type { RecoveryManagerOptions } from "@pico/runtime/recovery";

/** @deprecated 错误恢复策略已移至 @pico/runtime。 */
export class RecoveryManager extends RuntimeRecoveryManager {
  constructor() {
    super({ shellDialect: hostShellDialect });
  }
}
