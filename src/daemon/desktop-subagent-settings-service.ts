import { logger } from "../observability/logger.js";
import {
  UserConfigLockTimeoutError,
  UserConfigRevisionConflictError,
  type PicoUserConfig,
  type UserConfigStore,
} from "../input/user-config-store.js";
import { DesktopSubagentSettingsService as HostDesktopSubagentSettingsService } from "@pico/pico-host/desktop-subagent-settings-service";
import type { RuntimeSubagentConnection } from "@pico/protocol";

export interface DesktopSubagentSettingsServiceOptions {
  readonly userConfigStore: UserConfigStore;
  readonly revisionTokenKey: Buffer;
  readonly getConnections: () => Promise<readonly RuntimeSubagentConnection[]>;
  readonly onUpdated?: (revision: string) => Promise<void>;
}

/** @deprecated Desktop Subagent settings orchestration has moved to @pico/pico-host. */
export class DesktopSubagentSettingsService extends HostDesktopSubagentSettingsService<PicoUserConfig> {
  constructor(options: DesktopSubagentSettingsServiceOptions) {
    super({
      configStore: options.userConfigStore,
      revisionTokenKey: options.revisionTokenKey,
      getConnections: options.getConnections,
      ...(options.onUpdated ? { onUpdated: options.onUpdated } : {}),
      isRevisionConflictError: (error) => error instanceof UserConfigRevisionConflictError,
      isWriteLockedError: (error) => error instanceof UserConfigLockTimeoutError,
      onNotificationError: (error) =>
        logger.warn({ err: error }, "Subagent presets committed but refresh notification failed"),
    });
  }
}
