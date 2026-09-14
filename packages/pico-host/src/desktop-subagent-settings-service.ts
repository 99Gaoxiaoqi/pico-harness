import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeSubagentConnection,
  type RuntimeSubagentSettingsSnapshot,
} from "@pico/protocol";
import {
  normalizePicoSubagentSettings,
  type PicoSubagentSettings,
} from "@pico/protocol/subagent-settings";
import { createConfiguredSubagentCatalog } from "./configured-subagent-catalog.js";

export interface DesktopSubagentSettingsConfig {
  readonly subagents?: PicoSubagentSettings;
}

export interface DesktopSubagentSettingsConfigSnapshot<
  Config extends DesktopSubagentSettingsConfig,
> {
  readonly config: Config;
  readonly revision: string;
}

/** Atomic configuration port; its concrete lock and storage strategy remain outer-owned. */
export interface DesktopSubagentSettingsConfigStore<Config extends DesktopSubagentSettingsConfig> {
  read(): Promise<DesktopSubagentSettingsConfigSnapshot<Config>>;
  write(
    config: Config,
    options: { readonly expectedRevision: string },
  ): Promise<DesktopSubagentSettingsConfigSnapshot<Config>>;
}

export interface DesktopSubagentSettingsServiceOptions<
  Config extends DesktopSubagentSettingsConfig,
> {
  readonly configStore: DesktopSubagentSettingsConfigStore<Config>;
  readonly revisionTokenKey: Buffer;
  readonly getConnections: () => Promise<readonly RuntimeSubagentConnection[]>;
  readonly onUpdated?: (revision: string) => Promise<void>;
  readonly isRevisionConflictError?: (error: unknown) => boolean;
  readonly isWriteLockedError?: (error: unknown) => boolean;
  readonly onNotificationError?: (error: unknown) => void;
}

/** Device-wide presets retain the injected config port's atomic lock and revision protection. */
export class DesktopSubagentSettingsService<Config extends DesktopSubagentSettingsConfig> {
  constructor(private readonly options: DesktopSubagentSettingsServiceOptions<Config>) {}

  async get(params: unknown = {}): Promise<RuntimeSubagentSettingsSnapshot> {
    parseStrictRuntimeParams("subagents.get", params);
    return this.snapshot(await this.options.configStore.read());
  }

  async update(params: unknown): Promise<RuntimeSubagentSettingsSnapshot> {
    const input = parseStrictRuntimeParams("subagents.update", params);
    const current = await this.options.configStore.read();
    const expected = Buffer.from(input.expectedRevision, "hex");
    const actual = Buffer.from(this.revision(current.revision), "hex");
    if (!timingSafeEqual(expected, actual)) throw revisionConflict();

    let written: DesktopSubagentSettingsConfigSnapshot<Config>;
    try {
      written = await this.options.configStore.write(
        {
          ...current.config,
          subagents: normalizePicoSubagentSettings({ presets: input.presets }),
        },
        { expectedRevision: current.revision },
      );
    } catch (error) {
      if (this.options.isRevisionConflictError?.(error)) throw revisionConflict();
      if (this.options.isWriteLockedError?.(error)) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "用户配置正在写入，请稍后重试",
        );
      }
      throw error;
    }

    const snapshot = await this.snapshot(written);
    // The config is already durable. Notification failures must not invite a duplicate save.
    try {
      await this.options.onUpdated?.(snapshot.revision);
    } catch (error) {
      this.options.onNotificationError?.(error);
    }
    return snapshot;
  }

  private async snapshot(
    source: DesktopSubagentSettingsConfigSnapshot<Config>,
  ): Promise<RuntimeSubagentSettingsSnapshot> {
    // Project the injected connection DTO explicitly: credentials or internal Provider metadata
    // must never become Renderer-visible even when a dependency accidentally returns extra keys.
    const connections = (await this.options.getConnections()).map((connection) => ({
      id: connection.id,
      name: connection.name,
      enabled: connection.enabled,
      ...(connection.retired !== undefined ? { retired: connection.retired } : {}),
      models: connection.models.map((model) => ({
        id: model.id,
        thinkingLevels: [...model.thinkingLevels],
        offerable: model.offerable,
      })),
    }));
    const catalog = createConfiguredSubagentCatalog({
      getPresets: async () => source.config.subagents?.presets ?? [],
      getConnections: async () => connections,
    });
    return {
      presets: await catalog.list(),
      connections,
      revision: this.revision(source.revision),
    };
  }

  private revision(raw: string): string {
    return createHmac("sha256", this.options.revisionTokenKey)
      .update("pico.desktop.subagent-settings-revision.v1\0", "utf8")
      .update(raw, "utf8")
      .digest("hex");
  }
}

function revisionConflict(): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "用户配置已更改，请刷新后重试");
}
