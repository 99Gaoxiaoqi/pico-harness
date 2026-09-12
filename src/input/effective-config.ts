import { createHash } from "node:crypto";
import type { ModelProviderConfig } from "../provider/model-router.js";
import { loadPicoProjectConfig, type PicoProjectConfig } from "./pico-config.js";
import {
  UserConfigStore,
  type PicoCollaborationMode,
  type PicoOrchestrationMode,
  type PicoPermissionMode,
  type PicoUserConfigDefaults,
} from "./user-config-store.js";

export type ConfigSource = "user" | "environment" | "session" | "cli";

export interface EffectiveConfigDefaults {
  readonly modelRouteId?: string;
  readonly collaborationMode?: PicoCollaborationMode;
  readonly orchestrationMode?: PicoOrchestrationMode;
  readonly permissionMode?: PicoPermissionMode;
  readonly thinkingEffort?: string;
}

export interface EffectiveConfigSnapshot {
  readonly defaults: EffectiveConfigDefaults;
  /** Convenience alias used by ModelRouter callers. */
  readonly defaultModelRouteId?: string;
  readonly providers: Readonly<Record<string, ModelProviderConfig>>;
  /** Keys use `defaults.*` and `providers.<id>` paths. */
  readonly sources: Readonly<Record<string, ConfigSource>>;
  readonly revisions: {
    readonly user: string;
    readonly project: string;
  };
}

export interface ResolveEffectiveConfigOptions {
  readonly workDir: string;
  /** Project config must not even be read until the host has established trust. */
  readonly projectTrusted: boolean;
}

export interface EffectiveConfigResolverOptions {
  readonly userConfigStore?: UserConfigStore;
  readonly picoHome?: string;
}

/** Resolves durable configuration. CLI and Session overrides remain the caller's responsibility. */
export class EffectiveConfigResolver {
  private readonly userConfigStore: UserConfigStore;

  constructor(options: EffectiveConfigResolverOptions = {}) {
    this.userConfigStore =
      options.userConfigStore ?? new UserConfigStore({ picoHome: options.picoHome });
  }

  async resolve(options: ResolveEffectiveConfigOptions): Promise<EffectiveConfigSnapshot> {
    const user = await this.userConfigStore.read();
    const project = options.projectTrusted
      ? await loadPicoProjectConfig(options.workDir)
      : undefined;

    const providers = user.config.providers;
    // 项目侧 providers 已退役（2026-08-17）：provider 凭据只支持用户侧，
    // 项目配置里的 providers 段是 legacy 残留，解析保留但不再并入有效配置
    // 项目侧 model 默认路由同步退役（同日）：模型路由与用户凭据强耦合，
    // 项目侧只能引用无法保证存在的路由 ID（实测：项目钉死已删除的 provider
    // 会挡死整个工作区的新会话）。字段连同解析整体移除——parser 忽略未知键，
    // 旧仓库的 model 残值静默失效，格式非法也不再阻断配置加载。

    const sources: Record<string, ConfigSource> = {};
    for (const id of Object.keys(providers)) {
      sources[`providers.${id}`] = "user";
    }
    const defaults = resolveDefaults(user.config.defaults, sources);
    const defaultModelRouteId = defaults.modelRouteId;
    const frozenProviders = Object.freeze(
      Object.fromEntries(
        Object.entries(providers).map(([id, provider]) => [id, freezeProvider(provider)]),
      ),
    );

    return Object.freeze({
      defaults: Object.freeze(defaults),
      ...(defaultModelRouteId !== undefined ? { defaultModelRouteId } : {}),
      providers: frozenProviders,
      sources: Object.freeze({ ...sources }),
      revisions: Object.freeze({
        user: user.revision,
        project: project === undefined ? emptyRevision() : projectRevision(project),
      }),
    });
  }
}

function resolveDefaults(
  userDefaults: PicoUserConfigDefaults | undefined,
  sources: Record<string, ConfigSource>,
): EffectiveConfigDefaults {
  const defaults: {
    modelRouteId?: string;
    collaborationMode?: PicoCollaborationMode;
    orchestrationMode?: PicoOrchestrationMode;
    permissionMode?: PicoPermissionMode;
    thinkingEffort?: string;
  } = {};
  if (userDefaults?.modelRouteId !== undefined) {
    defaults.modelRouteId = userDefaults.modelRouteId;
    sources["defaults.modelRouteId"] = "user";
  }
  if (userDefaults?.collaborationMode !== undefined) {
    defaults.collaborationMode = userDefaults.collaborationMode;
    sources["defaults.collaborationMode"] = "user";
  }
  if (userDefaults?.orchestrationMode !== undefined) {
    defaults.orchestrationMode = userDefaults.orchestrationMode;
    sources["defaults.orchestrationMode"] = "user";
  }
  if (userDefaults?.permissionMode !== undefined) {
    defaults.permissionMode = userDefaults.permissionMode;
    sources["defaults.permissionMode"] = "user";
  }
  if (userDefaults?.thinkingEffort !== undefined) {
    defaults.thinkingEffort = userDefaults.thinkingEffort;
    sources["defaults.thinkingEffort"] = "user";
  }
  return defaults;
}

function freezeProvider(provider: ModelProviderConfig): ModelProviderConfig {
  return Object.freeze({
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    ...(provider.auth ? { auth: provider.auth } : {}),
    models: Object.freeze([...provider.models]),
    discoverModels: provider.discoverModels,
    ...(provider.modelProtocols !== undefined
      ? { modelProtocols: Object.freeze({ ...provider.modelProtocols }) }
      : {}),
    ...(provider.modelCapabilities !== undefined
      ? { modelCapabilities: Object.freeze({ ...provider.modelCapabilities }) }
      : {}),
  });
}

function projectRevision(config: PicoProjectConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

function emptyRevision(): string {
  return createHash("sha256").update("").digest("hex");
}
