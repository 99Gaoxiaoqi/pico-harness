import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeSubagentConnection,
  type RuntimeSubagentSettingsSnapshot,
} from "@pico/protocol";
import { createConfiguredSubagentCatalog } from "../agents/configured-subagent-catalog.js";
import { normalizePicoSubagentSettings } from "../input/subagent-settings.js";
import {
  UserConfigLockTimeoutError,
  UserConfigRevisionConflictError,
  type UserConfigSnapshot,
  type UserConfigStore,
} from "../input/user-config-store.js";

export interface DesktopSubagentSettingsServiceOptions {
  readonly userConfigStore: UserConfigStore;
  readonly revisionTokenKey: Buffer;
  readonly getConnections: () => Promise<readonly RuntimeSubagentConnection[]>;
  readonly onUpdated?: (revision: string) => Promise<void>;
}

/** Device-wide presets share the existing config file's atomic lock and revision protection. */
export class DesktopSubagentSettingsService {
  constructor(private readonly options: DesktopSubagentSettingsServiceOptions) {}

  async get(params: unknown = {}): Promise<RuntimeSubagentSettingsSnapshot> {
    parseStrictRuntimeParams("subagents.get", params);
    return this.snapshot(await this.options.userConfigStore.read());
  }

  async update(params: unknown): Promise<RuntimeSubagentSettingsSnapshot> {
    const input = parseStrictRuntimeParams("subagents.update", params);
    const current = await this.options.userConfigStore.read();
    const expected = Buffer.from(input.expectedRevision, "hex");
    const actual = Buffer.from(this.revision(current.revision), "hex");
    if (!timingSafeEqual(expected, actual)) throw revisionConflict();
    let written: UserConfigSnapshot;
    try {
      written = await this.options.userConfigStore.write(
        { ...current.config, subagents: normalizePicoSubagentSettings({ presets: input.presets }) },
        { expectedRevision: current.revision },
      );
    } catch (error) {
      if (error instanceof UserConfigRevisionConflictError) throw revisionConflict();
      if (error instanceof UserConfigLockTimeoutError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "用户配置正在写入，请稍后重试",
        );
      }
      throw error;
    }
    const snapshot = await this.snapshot(written);
    await this.options.onUpdated?.(snapshot.revision);
    return snapshot;
  }

  private async snapshot(source: UserConfigSnapshot): Promise<RuntimeSubagentSettingsSnapshot> {
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
