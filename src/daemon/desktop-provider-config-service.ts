import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EffectiveConfigResolver,
  ProviderIdConflictError,
  type ConfigSource,
} from "../input/effective-config.js";
import {
  loadPicoConfig,
  parseModelProviderConfigs,
  type PicoProjectConfig,
} from "../input/pico-config.js";
import {
  parseUserConfig,
  UserConfigLockTimeoutError,
  UserConfigRevisionConflictError,
  UserConfigStore,
  type PicoUserConfig,
  type PicoUserConfigDefaults,
  type UserConfigSnapshot,
} from "../input/user-config-store.js";
import {
  assertCredentialRefMatchesModelRoute,
  assertCredentialRefMatchesProvider,
  createPlatformCredentialVault,
  CredentialNotFoundError,
  credentialRefForProvider,
  importProviderCredential,
  normalizeProviderEndpoint,
  parseAnyCredentialRef,
  parseProviderCredentialRef,
  type CredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { type ModelProviderConfig } from "../provider/model-router.js";
import {
  ProviderOperationJournal,
  type ProviderOperationRecord,
} from "../provider/provider-operation-journal.js";
import {
  type ActiveAutomationReference,
  type AutomationProviderReference,
} from "./desktop-automation-service.js";
import {
  errorMessage,
  isJsonRecord,
  isNodeCode,
  isOneOf,
  requireJsonRecord,
  requireText,
  toJsonValue,
} from "./desktop-protocol-values.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonObject,
  type JsonValue,
  type RuntimeProviderInput,
} from "./protocol.js";

/** Host dependencies that remain outside Provider configuration ownership. */
export interface DesktopProviderConfigServiceOptions {
  readonly picoHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly revisionTokenKey: Buffer;
  readonly userConfigStore?: UserConfigStore;
  readonly effectiveConfigResolver?: EffectiveConfigResolver;
  readonly credentialVault?: CredentialVault;
  readonly providerOperationJournal?: ProviderOperationJournal;
  readonly initializeDefaultProvider?: boolean;
  readonly listWorkspacePaths: () => Promise<readonly string[]>;
  readonly requireTrustedWorkspace: (workspacePath: string) => Promise<string>;
  readonly assertNoActiveRuns: (
    workspacePaths: readonly string[],
    operation: string,
  ) => Promise<void>;
  readonly providerReferences: (
    providerId: string,
    workspacePaths: readonly string[],
  ) => readonly AutomationProviderReference[];
  readonly publishUserConfigUpdated: (
    revision: string,
    providerIds: readonly string[],
  ) => Promise<void>;
}

/** Owns Provider configuration, credential recovery, file watching and the shared admission lock. */
export class DesktopProviderConfigService {
  readonly userConfigStore: UserConfigStore;
  readonly effectiveConfigResolver: EffectiveConfigResolver;
  readonly credentialVault: CredentialVault;
  readonly ready: Promise<void>;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly providerOperationJournal: ProviderOperationJournal;
  private readonly providerRecoveryReady: Promise<void>;
  private readonly userConfigWatchListener = () => this.scheduleUserConfigRefresh();
  private userConfigWatchTail: Promise<void> = Promise.resolve();
  private providerDependencyTail: Promise<void> = Promise.resolve();
  private providerRecoveryError?: unknown;
  private userConfigWatchTimer?: NodeJS.Timeout;
  private observedUserConfig?: UserConfigSnapshot;
  private userConfigWatchClosed = false;

  constructor(private readonly options: DesktopProviderConfigServiceOptions) {
    this.env = options.env;
    this.userConfigStore =
      options.userConfigStore ?? new UserConfigStore({ picoHome: options.picoHome });
    this.effectiveConfigResolver =
      options.effectiveConfigResolver ??
      new EffectiveConfigResolver({ userConfigStore: this.userConfigStore });
    this.credentialVault =
      options.credentialVault ?? createPlatformCredentialVault(process.platform, this.env);
    this.providerOperationJournal =
      options.providerOperationJournal ??
      new ProviderOperationJournal({ picoHome: options.picoHome, parseUserConfig });
    this.providerRecoveryReady = this.recoverProviderOperation().catch((error: unknown) => {
      this.providerRecoveryError = error;
    });
    this.ready = this.startUserConfigWatch();
  }

  async close(): Promise<void> {
    this.userConfigWatchClosed = true;
    if (this.userConfigWatchTimer) clearTimeout(this.userConfigWatchTimer);
    unwatchFile(this.userConfigStore.filePath, this.userConfigWatchListener);
    await this.ready.catch(() => undefined);
    await this.userConfigWatchTail.catch(() => undefined);
    await this.providerDependencyTail.catch(() => undefined);
  }

  private async publishUserConfigUpdated(
    revision: string,
    providerIds: readonly string[],
  ): Promise<void> {
    await this.options.publishUserConfigUpdated(
      this.projectUserConfigRevision(revision),
      providerIds,
    );
  }

  async getConfig(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.options.requireTrustedWorkspace(workspacePath);
    const [config, version] = await Promise.all([
      loadPicoConfig(canonical),
      configContentVersion(canonical),
    ]);
    return { config: safeConfig(config), version };
  }

  async listProviders(workspacePath: string): Promise<JsonValue> {
    const canonical = await this.options.requireTrustedWorkspace(workspacePath);
    const config = await loadPicoConfig(canonical);
    return {
      providers: toJsonValue(
        Object.entries(config.providers).map(([id, provider]) =>
          runtimeProviderInput(id, provider),
        ),
      ),
    };
  }

  async getUserConfig(params: unknown): Promise<JsonValue> {
    assertExactObjectKeys(params, [], "config.user.get params");
    const snapshot = await this.userConfigStore.read();
    return {
      config: runtimeUserConfig(snapshot.config),
      revision: this.projectUserConfigRevision(snapshot.revision),
    };
  }

  async updateUserConfig(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["defaults", "expectedRevision"],
      "config.user.update params",
    );
    const defaults = normalizeRuntimeUserDefaults(record["defaults"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        providers: current.config.providers,
      },
      "config.user.update",
    );
    assertUserDefaultRoute(next);
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, []);
    return {
      config: runtimeUserConfig(written.config),
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  async getEffectiveConfig(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(params, ["workspacePath"], "config.effective.get params");
    const workspacePath = await this.options.requireTrustedWorkspace(
      requireText(record["workspacePath"], "workspacePath"),
    );
    let snapshot;
    try {
      snapshot = await this.effectiveConfigResolver.resolve({
        workDir: workspacePath,
        projectTrusted: true,
        env: this.env,
      });
    } catch (error) {
      if (error instanceof ProviderIdConflictError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      throw error;
    }
    const userProviders = (await this.userConfigStore.read()).config.providers;
    const providers = await Promise.all(
      Object.entries(snapshot.providers)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, provider]) => {
          const origin = providerOrigin(snapshot.sources[`providers.${id}`]);
          const userProvider = userProviders[id];
          const supportsSharedCredential =
            origin === "user" ||
            (userProvider !== undefined &&
              userProvider.protocol === provider.protocol &&
              sameProviderEndpoint(userProvider.baseURL, provider.baseURL));
          return this.projectProviderProfile(
            id,
            provider,
            origin,
            supportsSharedCredential,
            supportsSharedCredential && userProvider ? userProvider : provider,
          );
        }),
    );
    return {
      config: {
        ...(snapshot.defaultModelRouteId
          ? { defaultModelRouteId: snapshot.defaultModelRouteId }
          : {}),
        defaults: toJsonValue(snapshot.defaults),
        providers,
        sources: toJsonValue(snapshot.sources),
        revisions: {
          ...snapshot.revisions,
          user: this.projectUserConfigRevision(snapshot.revisions.user),
        },
      },
    };
  }

  async listUserProviders(params: unknown): Promise<JsonValue> {
    assertExactObjectKeys(params, [], "provider.list params");
    const snapshot = await this.userConfigStore.read();
    const providers = await Promise.all(
      Object.entries(snapshot.config.providers)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, provider]) => this.projectProviderProfile(id, provider, "user")),
    );
    return { providers, revision: this.projectUserConfigRevision(snapshot.revision) };
  }

  async upsertUserProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["provider", "expectedRevision"],
      "provider.upsert params",
    );
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const { id, config } = normalizeRuntimeProvider(record["provider"]);
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const previousProvider = current.config.providers[id];
    const workspacePaths = await this.options.listWorkspacePaths();
    this.assertProviderCompatibleWithAutomationReferences(
      id,
      config,
      this.options.providerReferences(id, workspacePaths),
    );
    if (
      previousProvider &&
      (previousProvider.protocol !== config.protocol ||
        !sameProviderEndpoint(previousProvider.baseURL, config.baseURL))
    ) {
      await this.assertNoStoredCredentialBeforeAuthorityChange(id, previousProvider);
    }
    const nextProvider = retainConfiguredCredential(config, previousProvider);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [id]: nextProvider },
      },
      "provider.upsert",
    );
    assertUserDefaultRoute(next);
    const written = await this.writeUserConfig(next, current.revision);
    const provider = await this.projectProviderProfile(id, written.config.providers[id]!, "user");
    await this.publishUserConfigUpdated(written.revision, [id]);
    return { provider, revision: this.projectUserConfigRevision(written.revision) };
  }

  async importEnvironmentProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["provider", "defaultModel", "secret", "expectedRevision"],
      "provider.importEnvironment params",
    );
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const { id, config } = normalizeRuntimeProvider(record["provider"]);
    if (config.auth === "none") {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "免密钥 Provider 不接受凭据导入",
      );
    }
    const defaultModel = requireText(record["defaultModel"], "defaultModel");
    if (!config.models.includes(defaultModel)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `默认模型 ${defaultModel} 不在 Provider ${id} 的显式模型列表中`,
      );
    }
    const capability = this.credentialVault.capability();
    if (!capability.available) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.FORBIDDEN, capability.diagnostic);
    }
    const secret = requireSecret(record["secret"]);
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const previousProvider = current.config.providers[id];
    if (previousProvider && !sameProviderAuthority(previousProvider, config)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 已使用不同的协议或 Endpoint，请先显式删除后再导入`,
      );
    }
    if (previousProvider && configuredCredential(previousProvider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 已在用户配置中保存 API Key，请先删除配置中的 Key 再导入旧版环境凭证`,
      );
    }
    const workspacePaths = await this.options.listWorkspacePaths();
    this.assertProviderCompatibleWithAutomationReferences(
      id,
      config,
      this.options.providerReferences(id, workspacePaths),
    );
    const next = validatedUserConfig(
      {
        version: 1,
        defaults: {
          ...current.config.defaults,
          modelRouteId: current.config.defaults?.modelRouteId ?? `${id}/${defaultModel}`,
        },
        providers: { ...current.config.providers, [id]: config },
      },
      "provider.importEnvironment",
    );
    assertUserDefaultRoute(next);
    const credentialRef = credentialRefForProvider(providerCredentialIdentity(id, config));
    const pending = await this.providerOperationJournal.prepare({
      kind: "import",
      previousUserConfig: current.config,
      targetUserConfig: next,
      credentialRef,
      credentialExistedBefore: await this.credentialVault.has(credentialRef),
      configRevision: current.revision,
    });
    try {
      await importProviderCredential({
        provider: providerCredentialIdentity(id, config),
        secret,
        vault: this.credentialVault,
      });
      await this.providerOperationJournal.update(pending.operationId, {
        phase: "credential-imported",
      });
    } catch (error) {
      if (!pending.credentialExistedBefore) {
        await this.credentialVault.delete(credentialRef).catch(() => undefined);
      }
      await this.providerOperationJournal.clear(pending.operationId).catch(() => undefined);
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${id} 凭证导入失败，用户配置尚未变更: ${redactedErrorMessage(error, secret)}`,
      );
    }
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
    const provider = await this.projectProviderProfile(id, written.config.providers[id]!, "user");
    await this.publishUserConfigUpdated(written.revision, [id]);
    return { provider, revision: this.projectUserConfigRevision(written.revision) };
  }

  async deleteUserProvider(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "expectedRevision"],
      "provider.delete params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    const provider = current.config.providers[providerId];
    if (!provider) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Provider ${providerId} 不存在`,
      );
    }
    this.assertUserConfigRevision(expectedRevision, current.revision);
    if (configuredCredential(provider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 已在用户配置中保存 API Key，请先删除配置中的 Key 再删除 Provider`,
      );
    }
    if (providerIdForModelRoute(current.config.defaults?.modelRouteId) === providerId) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 仍是用户默认模型路由，请先更换默认模型`,
      );
    }
    const workspacePaths = await this.options.listWorkspacePaths();
    await this.assertProviderDependenciesIdle(providerId, workspacePaths);
    const credentialRef = credentialRefForProvider(
      providerCredentialIdentity(providerId, provider),
    );
    const storedCredential = await this.hasStoredProviderCredential(providerId, credentialRef);
    const providers = { ...current.config.providers };
    delete providers[providerId];
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers,
      },
      "provider.delete",
    );
    const pending = await this.providerOperationJournal.prepare({
      kind: "delete",
      previousUserConfig: current.config,
      targetUserConfig: next,
      credentialRef,
      credentialExistedBefore: storedCredential,
      configRevision: current.revision,
    });
    if (storedCredential) {
      try {
        await this.credentialVault.delete(credentialRef);
      } catch (error) {
        if (!(error instanceof CredentialNotFoundError)) {
          await this.providerOperationJournal.clear(pending.operationId).catch(() => undefined);
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            `Provider ${providerId} 的系统凭证删除失败，用户配置尚未变更: ${errorMessage(error)}`,
          );
        }
      }
    }
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "credential-deleted",
    });
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    return { deleted: true, revision: this.projectUserConfigRevision(written.revision) };
  }

  async getProviderCredentialStatus(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId"],
      "provider.credential.status params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const provider = await this.requireUserProvider(providerId);
    return {
      providerId,
      ...(await this.projectCredentialStatus(providerId, provider)),
      providerFingerprint: providerFingerprint(providerId, provider),
    };
  }

  async setProviderCredential(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "secret", "expectedRevision"],
      "provider.credential.set params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const provider = requireProviderFromUserConfig(current.config, providerId);
    if (provider.auth === "none") {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "免密钥 Provider 不接受 API Key",
      );
    }
    const fingerprint = providerFingerprint(providerId, provider);
    const secret = requireSecret(record["secret"]);
    if (configuredCredential(provider) === secret) {
      return {
        providerId,
        status: "ready",
        source: "config",
        storedCredentialPresent: true,
        providerFingerprint: fingerprint,
        revision: this.projectUserConfigRevision(current.revision),
      };
    }
    const nextProvider = withConfiguredCredential(provider, secret);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [providerId]: nextProvider },
      },
      "provider.credential.set",
    );
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    return {
      providerId,
      status: "ready",
      source: "config",
      storedCredentialPresent: true,
      providerFingerprint: fingerprint,
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  async deleteProviderCredential(params: unknown): Promise<JsonValue> {
    const record = assertExactObjectKeys(
      params,
      ["providerId", "expectedRevision"],
      "provider.credential.delete params",
    );
    const providerId = requireProviderId(record["providerId"]);
    const expectedRevision = requireSha256(record["expectedRevision"], "expectedRevision");
    const current = await this.userConfigStore.read();
    this.assertUserConfigRevision(expectedRevision, current.revision);
    const provider = requireProviderFromUserConfig(current.config, providerId);
    const fingerprint = providerFingerprint(providerId, provider);
    const workspacePaths = await this.options.listWorkspacePaths();
    await this.assertProviderDependenciesIdle(providerId, workspacePaths);
    if (configuredCredential(provider) === undefined) {
      const status = await this.projectCredentialStatus(providerId, provider);
      return {
        providerId,
        status: status.credentialStatus,
        source: status.credentialSource,
        storedCredentialPresent: status.storedCredentialPresent,
        providerFingerprint: fingerprint,
        revision: this.projectUserConfigRevision(current.revision),
      };
    }
    const nextProvider = withoutConfiguredCredential(provider);
    const next = validatedUserConfig(
      {
        version: 1,
        ...(current.config.defaults ? { defaults: current.config.defaults } : {}),
        providers: { ...current.config.providers, [providerId]: nextProvider },
      },
      "provider.credential.delete",
    );
    const written = await this.writeUserConfig(next, current.revision);
    await this.publishUserConfigUpdated(written.revision, [providerId]);
    const status = await this.projectCredentialStatus(
      providerId,
      written.config.providers[providerId]!,
    );
    return {
      providerId,
      status: status.credentialStatus,
      source: status.credentialSource,
      storedCredentialPresent: status.storedCredentialPresent,
      providerFingerprint: fingerprint,
      revision: this.projectUserConfigRevision(written.revision),
    };
  }

  private async requireUserProvider(providerId: string): Promise<ModelProviderConfig> {
    const provider = (await this.userConfigStore.read()).config.providers[providerId];
    if (!provider) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.NOT_FOUND,
        `Provider ${providerId} 不存在`,
      );
    }
    return provider;
  }

  private async assertNoStoredCredentialBeforeAuthorityChange(
    providerId: string,
    provider: ModelProviderConfig,
  ): Promise<void> {
    if (provider.auth === "none") return;
    if (configuredCredential(provider) !== undefined) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 已在用户配置中保存 API Key，请先删除 API Key 再修改 Endpoint 或协议`,
      );
    }
    const capability = this.credentialVault.capability();
    if (!capability.available && !capability.cleanupAvailable) return;
    let stored: boolean;
    try {
      stored = await this.credentialVault.has(
        credentialRefForProvider(providerCredentialIdentity(providerId, provider)),
      );
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法确认 Provider ${providerId} 的系统凭证状态，已拒绝变更: ${errorMessage(error)}`,
      );
    }
    if (stored) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `Provider ${providerId} 仍有旧版系统凭证，请先清理后再修改 Endpoint 或协议`,
      );
    }
  }

  private async projectProviderProfile(
    id: string,
    provider: ModelProviderConfig,
    origin: "user" | "project-legacy" | "environment",
    supportsSharedCredential = true,
    credentialProvider = provider,
  ): Promise<JsonObject> {
    return {
      ...runtimeProviderInput(id, provider),
      origin,
      fingerprint: providerFingerprint(id, provider),
      ...(await this.projectCredentialStatus(id, credentialProvider, supportsSharedCredential)),
    };
  }

  private async projectCredentialStatus(
    providerId: string,
    provider: ModelProviderConfig,
    supportsSharedCredential = true,
  ): Promise<{
    readonly credentialStatus: "ready" | "missing" | "environment" | "unsupported";
    readonly credentialSource: "config" | "keychain" | "environment" | "none";
    readonly storedCredentialPresent: boolean;
  }> {
    if (provider.auth === "none") {
      return {
        credentialStatus: "ready",
        credentialSource: "none",
        storedCredentialPresent: false,
      };
    }
    if (configuredCredential(provider) !== undefined) {
      return {
        credentialStatus: "ready",
        credentialSource: "config",
        storedCredentialPresent: true,
      };
    }
    const environmentCredentialPresent = Boolean(
      readEnvironmentSecret(this.env, provider.apiKeyEnv),
    );
    if (!supportsSharedCredential) {
      return environmentCredentialPresent
        ? {
            credentialStatus: "environment",
            credentialSource: "environment",
            storedCredentialPresent: false,
          }
        : {
            credentialStatus: "unsupported",
            credentialSource: "none",
            storedCredentialPresent: false,
          };
    }
    const capability = this.credentialVault.capability();
    try {
      const ref = credentialRefForProvider(providerCredentialIdentity(providerId, provider));
      const storedCredentialPresent =
        capability.available || capability.cleanupAvailable
          ? await this.credentialVault.has(ref)
          : false;
      if (storedCredentialPresent) {
        return {
          credentialStatus: "ready",
          credentialSource: "keychain",
          storedCredentialPresent: true,
        };
      }
      if (environmentCredentialPresent) {
        return {
          credentialStatus: "environment",
          credentialSource: "environment",
          storedCredentialPresent: false,
        };
      }
      return {
        credentialStatus: capability.available ? "missing" : "unsupported",
        credentialSource: "none",
        storedCredentialPresent: false,
      };
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法读取 Provider ${providerId} 的系统凭证状态: ${errorMessage(error)}`,
      );
    }
  }

  private async writeUserConfig(config: PicoUserConfig, expectedRevision: string) {
    // Do not let the async watch bootstrap replace a snapshot written through this service.
    await this.ready;
    try {
      const written = await this.userConfigStore.write(config, { expectedRevision });
      this.observedUserConfig = written;
      return written;
    } catch (error) {
      if (error instanceof UserConfigRevisionConflictError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "用户配置已更改，请刷新后重试",
        );
      }
      if (error instanceof UserConfigLockTimeoutError) {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
      }
      throw error;
    }
  }

  private async startUserConfigWatch(): Promise<void> {
    try {
      this.observedUserConfig = this.options.initializeDefaultProvider
        ? await this.userConfigStore.ensureDefaultProvider(this.env)
        : await this.userConfigStore.read();
    } catch {
      // The typed config methods surface corrupt state. Keep watching so an external repair
      // is detected without requiring a daemon restart.
    }
    if (this.userConfigWatchClosed) return;
    watchFile(
      this.userConfigStore.filePath,
      { persistent: false, interval: 200 },
      this.userConfigWatchListener,
    );
  }

  private scheduleUserConfigRefresh(): void {
    if (this.userConfigWatchClosed) return;
    if (this.userConfigWatchTimer) clearTimeout(this.userConfigWatchTimer);
    this.userConfigWatchTimer = setTimeout(() => {
      this.userConfigWatchTimer = undefined;
      this.userConfigWatchTail = this.userConfigWatchTail
        .then(
          () => this.refreshObservedUserConfig(),
          () => this.refreshObservedUserConfig(),
        )
        .catch(() => undefined);
    }, 60);
    this.userConfigWatchTimer.unref();
  }

  private async refreshObservedUserConfig(): Promise<void> {
    if (this.userConfigWatchClosed) return;
    const current = await this.userConfigStore.read();
    const previous = this.observedUserConfig;
    if (previous?.revision === current.revision) return;
    this.observedUserConfig = current;
    await this.publishUserConfigUpdated(
      current.revision,
      changedProviderIds(previous?.config.providers, current.config.providers),
    );
  }

  private async assertProviderDependenciesIdle(
    providerId: string,
    workspacePaths: readonly string[],
  ): Promise<void> {
    await this.options.assertNoActiveRuns(
      workspacePaths,
      `删除 Provider ${providerId} 或其系统凭证`,
    );
    const automationReferences = this.options.providerReferences(providerId, workspacePaths);
    if (automationReferences.length > 0) {
      const active = automationReferences.find(isActiveAutomationReference);
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        active
          ? `Provider ${providerId} 仍被运行中 Automation Run ${active.runId} 引用`
          : `Provider ${providerId} 仍被已启用 Automation ${automationReferences[0]!.jobId} 引用`,
      );
    }
  }

  private assertProviderCompatibleWithAutomationReferences(
    providerId: string,
    provider: ModelProviderConfig,
    references: readonly AutomationProviderReference[],
  ): void {
    for (const reference of references) {
      const modelRouteId = reference.modelRouteId;
      const separator = modelRouteId?.indexOf("/") ?? -1;
      const model = separator > 0 ? modelRouteId!.slice(separator + 1) : undefined;
      if (!model || !provider.models.includes(model)) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider ${providerId} 的模型变更会破坏 Automation ${reference.jobId} 固定的路由 ${modelRouteId ?? "<unknown>"}`,
        );
      }
      if (!reference.credentialRef) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Automation ${reference.jobId} 缺少可验证的 credentialRef，已拒绝变更 Provider ${providerId}`,
        );
      }
      try {
        const parsed = parseAnyCredentialRef(reference.credentialRef);
        if (parsed.version === "v2") {
          assertCredentialRefMatchesProvider(
            reference.credentialRef,
            providerCredentialIdentity(providerId, provider),
          );
        } else {
          assertCredentialRefMatchesModelRoute(
            reference.credentialRef,
            {
              id: modelRouteId!,
              provider: provider.modelProtocols?.[model] ?? provider.protocol,
              baseURL: provider.baseURL,
              model,
              apiKeyEnv: provider.apiKeyEnv,
              ...(provider.auth ? { auth: provider.auth } : {}),
            },
            reference.workspacePath,
          );
        }
      } catch (error) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider ${providerId} 的协议或 Endpoint 变更会破坏 Automation ${reference.jobId}: ${errorMessage(error)}`,
        );
      }
    }
  }

  private async hasStoredProviderCredential(
    providerId: string,
    credentialRef: CredentialRef,
  ): Promise<boolean> {
    const capability = this.credentialVault.capability();
    // An unavailable adapter cannot have accepted a v2 credential on this platform.
    // Preserve configuration management on Linux/Windows while still failing closed on
    // metadata errors from an actually available vault.
    if (!capability.available && !capability.cleanupAvailable) return false;
    try {
      return await this.credentialVault.has(credentialRef);
    } catch (error) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.CONFLICT,
        `无法确认 Provider ${providerId} 的系统凭证状态，已拒绝删除: ${errorMessage(error)}`,
      );
    }
  }

  private async recoverProviderOperation(): Promise<void> {
    let pending = await this.providerOperationJournal.read();
    if (!pending) return;
    if (pending.phase === "config-committed") {
      await this.providerOperationJournal.clear(pending.operationId);
      return;
    }
    if (pending.kind === "import") {
      if (!this.credentialVault.capability().available) {
        throw new Error(
          `Provider 操作 ${pending.operationId} 等待凭证后端恢复: ${this.credentialVault.capability().diagnostic}`,
        );
      }
      const credentialPresent = await this.credentialVault.has(pending.credentialRef);
      if (!credentialPresent) {
        if (pending.phase === "prepared") {
          await this.providerOperationJournal.clear(pending.operationId);
          return;
        }
        throw new Error(`Provider 操作 ${pending.operationId} 的凭证阶段已提交但凭证不存在`);
      }
      if (pending.phase === "prepared") {
        pending = await this.providerOperationJournal.update(pending.operationId, {
          phase: "credential-imported",
        });
      }
    } else if (pending.phase === "prepared") {
      const capability = this.credentialVault.capability();
      if (
        pending.credentialExistedBefore &&
        !capability.available &&
        !capability.cleanupAvailable
      ) {
        throw new Error(
          `Provider 删除 ${pending.operationId} 等待凭证后端恢复: ${this.credentialVault.capability().diagnostic}`,
        );
      }
      if (pending.credentialExistedBefore) {
        try {
          await this.credentialVault.delete(pending.credentialRef);
        } catch (error) {
          if (!(error instanceof CredentialNotFoundError)) throw error;
        }
      }
      pending = await this.providerOperationJournal.update(pending.operationId, {
        phase: "credential-deleted",
      });
    }
    const written = await this.commitProviderOperationConfig(pending);
    await this.providerOperationJournal.update(pending.operationId, {
      phase: "config-committed",
      configRevision: written.revision,
    });
    await this.providerOperationJournal.clear(pending.operationId);
  }

  private async commitProviderOperationConfig(
    operation: ProviderOperationRecord,
  ): Promise<UserConfigSnapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.userConfigStore.read();
      const next = reconcileProviderOperationConfig(operation, current.config);
      if (sameConfigValue(next, current.config)) return current;
      try {
        return await this.userConfigStore.write(next, { expectedRevision: current.revision });
      } catch (error) {
        if (!(error instanceof UserConfigRevisionConflictError)) throw error;
      }
    }
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `Provider 操作 ${operation.operationId} 在并发配置更新后仍无法提交，请刷新后重试`,
    );
  }

  async withProviderDependencyLock<Result extends JsonValue>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const guarded = async () => {
      await this.providerRecoveryReady;
      if (this.providerRecoveryError) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `Provider 配置恢复尚未完成，已拒绝新的依赖变更: ${errorMessage(this.providerRecoveryError)}`,
        );
      }
      await this.recoverProviderOperation();
      return operation();
    };
    const queued = this.providerDependencyTail.then(guarded, guarded);
    this.providerDependencyTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private assertUserConfigRevision(expected: string, actual: string): void {
    const expectedBytes = Buffer.from(expected, "hex");
    const actualBytes = Buffer.from(this.projectUserConfigRevision(actual), "hex");
    if (!timingSafeEqual(expectedBytes, actualBytes)) {
      throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "用户配置已更改，请刷新后重试");
    }
  }

  private projectUserConfigRevision(revision: string): string {
    return createHmac("sha256", this.options.revisionTokenKey)
      .update("pico.desktop.user-config-revision.v1\0", "utf8")
      .update(revision, "utf8")
      .digest("hex");
  }
}

function reconcileProviderOperationConfig(
  operation: ProviderOperationRecord,
  current: PicoUserConfig,
): PicoUserConfig {
  const providerId = parseProviderCredentialRef(operation.credentialRef).providerId;
  const previousProvider = operation.previousUserConfig.providers[providerId];
  const targetProvider = operation.targetUserConfig.providers[providerId];
  const currentProvider = current.providers[providerId];
  if (
    !sameConfigValue(currentProvider, previousProvider) &&
    !sameConfigValue(currentProvider, targetProvider)
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      `Provider ${providerId} 在恢复操作期间被修改，拒绝覆盖`,
    );
  }

  const providers = { ...current.providers };
  if (targetProvider) providers[providerId] = targetProvider;
  else delete providers[providerId];

  const defaults = { ...(current.defaults ?? {}) };
  const previousDefault = operation.previousUserConfig.defaults?.modelRouteId;
  const targetDefault = operation.targetUserConfig.defaults?.modelRouteId;
  if (previousDefault !== targetDefault && defaults.modelRouteId === previousDefault) {
    if (targetDefault === undefined) delete defaults.modelRouteId;
    else defaults.modelRouteId = targetDefault;
  }
  const next = validatedUserConfig(
    {
      version: 1,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
      providers,
    },
    `provider.${operation.kind}.recovery`,
  );
  assertUserDefaultRoute(next);
  return next;
}

function sameConfigValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function redactedErrorMessage(error: unknown, secret: string): string {
  return errorMessage(error).split(secret).join("<redacted>");
}

function runtimeUserConfig(config: PicoUserConfig): JsonObject {
  return {
    version: 1,
    defaults: toJsonValue(config.defaults ?? {}),
    providers: Object.entries(config.providers)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([id, provider]) => runtimeProviderInput(id, provider)),
  };
}

function runtimeProviderInput(id: string, provider: ModelProviderConfig): JsonObject {
  const modelCapabilities =
    provider.modelCapabilities === undefined
      ? undefined
      : requireJsonRecord(toJsonValue(provider.modelCapabilities), "modelCapabilities");
  return {
    id,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    ...(provider.auth ? { auth: provider.auth } : {}),
    models: [...provider.models],
    discoverModels: provider.discoverModels,
    ...(provider.modelProtocols ? { modelProtocols: { ...provider.modelProtocols } } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
  } satisfies RuntimeProviderInput;
}

type ConfigCredentialProvider = ModelProviderConfig & { readonly apiKey?: string };

function configuredCredential(provider: ModelProviderConfig): string | undefined {
  const value = (provider as ConfigCredentialProvider).apiKey?.trim();
  return value || undefined;
}

function withConfiguredCredential(
  provider: ModelProviderConfig,
  apiKey: string,
): ModelProviderConfig {
  return { ...provider, apiKey } as ConfigCredentialProvider;
}

function withoutConfiguredCredential(provider: ModelProviderConfig): ModelProviderConfig {
  const next = { ...provider } as ModelProviderConfig & { apiKey?: string };
  delete next.apiKey;
  return next;
}

function retainConfiguredCredential(
  provider: ModelProviderConfig,
  previous: ModelProviderConfig | undefined,
): ModelProviderConfig {
  if (provider.auth === "none") return provider;
  const apiKey = previous === undefined ? undefined : configuredCredential(previous);
  return apiKey === undefined ? provider : withConfiguredCredential(provider, apiKey);
}

function requireProviderFromUserConfig(
  config: PicoUserConfig,
  providerId: string,
): ModelProviderConfig {
  const provider = config.providers[providerId];
  if (!provider) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, `Provider ${providerId} 不存在`);
  }
  return provider;
}

function normalizeRuntimeUserDefaults(value: unknown): PicoUserConfigDefaults {
  const record = assertExactObjectKeys(
    value,
    ["modelRouteId", "mode", "thinkingEffort"],
    "defaults",
  );
  const modelRouteId = record["modelRouteId"];
  const mode = record["mode"];
  const thinkingEffort = record["thinkingEffort"];
  if (
    modelRouteId !== undefined &&
    (typeof modelRouteId !== "string" || !/^[^/\s]+\/.+$/u.test(modelRouteId.trim()))
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.modelRouteId 必须使用 providerID/modelID 格式",
    );
  }
  if (mode !== undefined && !isOneOf(mode, ["default", "plan", "auto", "yolo"] as const)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.mode 必须是 default、plan、auto 或 yolo",
    );
  }
  if (
    thinkingEffort !== undefined &&
    (typeof thinkingEffort !== "string" || !thinkingEffort.trim())
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "defaults.thinkingEffort 必须是非空字符串",
    );
  }
  return {
    ...(typeof modelRouteId === "string" ? { modelRouteId: modelRouteId.trim() } : {}),
    ...(isOneOf(mode, ["default", "plan", "auto", "yolo"] as const) ? { mode } : {}),
    ...(typeof thinkingEffort === "string" ? { thinkingEffort: thinkingEffort.trim() } : {}),
  };
}

function normalizeRuntimeProvider(value: unknown): {
  readonly id: string;
  readonly config: ModelProviderConfig;
} {
  const record = assertExactObjectKeys(
    value,
    [
      "id",
      "protocol",
      "baseURL",
      "apiKeyEnv",
      "auth",
      "models",
      "discoverModels",
      "modelCapabilities",
      "modelProtocols",
    ],
    "provider",
  );
  const id = requireProviderId(record["id"]);
  const protocol = record["protocol"];
  if (!isOneOf(protocol, ["openai", "claude", "responses"] as const)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.protocol 必须是 openai、claude 或 responses",
    );
  }
  const auth = record["auth"];
  if (auth !== undefined && !isOneOf(auth, ["api-key", "none"] as const)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.auth 必须是 api-key 或 none",
    );
  }
  const baseURL = requireText(record["baseURL"], "provider.baseURL");
  let normalizedEndpoint: string;
  try {
    normalizedEndpoint = normalizeProviderEndpoint(baseURL);
  } catch (error) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
  const apiKeyEnv = requireText(record["apiKeyEnv"], "provider.apiKeyEnv");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.apiKeyEnv 必须是环境变量名",
    );
  }
  const rawModels = record["models"];
  if (!Array.isArray(rawModels) || rawModels.some((model) => typeof model !== "string")) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 必须是字符串数组",
    );
  }
  const models = rawModels.map((model) => String(model).trim()).filter(Boolean);
  if (new Set(models).size !== models.length) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 不能包含重复模型",
    );
  }
  const discoverModels = record["discoverModels"];
  if (typeof discoverModels !== "boolean") {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.discoverModels 必须是布尔值",
    );
  }
  if (models.length === 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.models 首版必须至少包含一个显式模型",
    );
  }
  if (discoverModels && protocol !== "openai") {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.discoverModels 首版仅支持 openai 协议",
    );
  }
  const modelCapabilitiesValue = record["modelCapabilities"];
  const modelCapabilities =
    modelCapabilitiesValue === undefined
      ? undefined
      : assertExactModelCapabilities(modelCapabilitiesValue, models);
  const rawProvider = {
    protocol,
    ...(record["modelProtocols"] !== undefined ? { modelProtocols: record["modelProtocols"] } : {}),
    baseURL: normalizedEndpoint,
    apiKeyEnv,
    ...(auth !== undefined ? { auth } : {}),
    discoverModels,
    models:
      modelCapabilities === undefined
        ? models
        : Object.fromEntries(models.map((model) => [model, modelCapabilities[model] ?? {}])),
  };
  try {
    const config = parseModelProviderConfigs({ [id]: rawProvider }, "provider.upsert")[id];
    if (!config) throw new Error(`Provider ${id} 解析后丢失`);
    return { id, config };
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
}

function assertExactModelCapabilities(value: unknown, models: readonly string[]): JsonObject {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "provider.modelCapabilities 必须是对象",
    );
  }
  for (const [model, capabilities] of Object.entries(value)) {
    if (!models.includes(model)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `provider.modelCapabilities.${model} 不在 models 列表中`,
      );
    }
    if (!isJsonRecord(capabilities)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        `provider.modelCapabilities.${model} 必须是对象`,
      );
    }
  }
  return value;
}

function validatedUserConfig(config: PicoUserConfig, operation: string): PicoUserConfig {
  try {
    return parseUserConfig(config, operation);
  } catch (error) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, errorMessage(error));
  }
}

function assertUserDefaultRoute(config: PicoUserConfig): void {
  const routeId = config.defaults?.modelRouteId;
  if (!routeId) return;
  const separator = routeId.indexOf("/");
  const providerId = routeId.slice(0, separator);
  const model = routeId.slice(separator + 1);
  const provider = config.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `默认模型路由 ${routeId} 不在用户 Provider 模型列表中`,
    );
  }
}

function providerFingerprint(providerId: string, provider: ModelProviderConfig): string {
  return createHash("sha256")
    .update(
      stableJson({
        providerId,
        protocol: provider.protocol,
        baseURL: provider.baseURL.trim().replace(/\/+$/u, ""),
        apiKeyEnv: provider.apiKeyEnv,
        ...(provider.auth ? { auth: provider.auth } : {}),
        models: [...provider.models],
        discoverModels: provider.discoverModels,
        modelCapabilities: provider.modelCapabilities ?? {},
        ...(provider.modelProtocols ? { modelProtocols: provider.modelProtocols } : {}),
      }),
    )
    .digest("hex");
}

function changedProviderIds(
  previous: Readonly<Record<string, ModelProviderConfig>> | undefined,
  current: Readonly<Record<string, ModelProviderConfig>>,
): string[] {
  const ids = new Set([...Object.keys(previous ?? {}), ...Object.keys(current)]);
  return [...ids]
    .filter((id) => {
      const before = previous?.[id];
      const after = current[id];
      if (!before || !after) return true;
      return (
        providerFingerprint(id, before) !== providerFingerprint(id, after) ||
        configuredCredential(before) !== configuredCredential(after)
      );
    })
    .toSorted();
}

function providerCredentialIdentity(providerId: string, provider: ModelProviderConfig) {
  return {
    providerId,
    protocol: provider.protocol,
    baseURL: provider.baseURL,
  } as const;
}

function sameProviderEndpoint(left: string, right: string): boolean {
  try {
    return normalizeProviderEndpoint(left) === normalizeProviderEndpoint(right);
  } catch {
    return left.trim().replace(/\/+$/u, "") === right.trim().replace(/\/+$/u, "");
  }
}

function providerOrigin(
  source: ConfigSource | undefined,
): "user" | "project-legacy" | "environment" {
  if (source === "user" || source === "project-legacy" || source === "environment") {
    return source;
  }
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.INTERNAL_ERROR,
    `Provider 配置来源无效: ${String(source)}`,
  );
}

function readEnvironmentSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return env[name]
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
}

function requireProviderId(value: unknown): string {
  const providerId = requireText(value, "providerId");
  if (
    !/^[^/\s]+$/u.test(providerId) ||
    ["__proto__", "prototype", "constructor"].includes(providerId)
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "providerId 不能包含空白或斜杠",
    );
  }
  return providerId;
}

function providerIdForModelRoute(modelRouteId: string | undefined): string | undefined {
  if (!modelRouteId) return undefined;
  const separator = modelRouteId.indexOf("/");
  return separator > 0 ? modelRouteId.slice(0, separator) : undefined;
}

function sameProviderAuthority(left: ModelProviderConfig, right: ModelProviderConfig): boolean {
  return left.protocol === right.protocol && sameProviderEndpoint(left.baseURL, right.baseURL);
}

function isActiveAutomationReference(
  reference: AutomationProviderReference,
): reference is ActiveAutomationReference {
  return "runId" in reference;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `${field} 必须是小写 SHA-256`,
    );
  }
  return value;
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      "secret 必须是不含换行的非空字符串",
    );
  }
  return value.trim();
}

function assertExactObjectKeys(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): JsonObject {
  if (!isJsonRecord(value)) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.INVALID_PARAMS, `${label} 必须是对象`);
  }
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `${label} 包含未知字段: ${unexpected.join(", ")}`,
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeConfig(config: PicoProjectConfig): JsonValue {
  return toJsonValue({
    schemaVersion: config.version,
    commandsDir: config.commandsDir,
    additionalDirectories: config.additionalDirectories,
    keybindings: config.keybindings,
    sandbox: config.sandbox,
    lspServers: config.lspServers,
  });
}

async function configContentVersion(workspacePath: string): Promise<number> {
  try {
    const content = await readFile(join(workspacePath, ".pico", "config.json"));
    return Number.parseInt(createHash("sha256").update(content).digest("hex").slice(0, 8), 16);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return 0;
    throw error;
  }
}
