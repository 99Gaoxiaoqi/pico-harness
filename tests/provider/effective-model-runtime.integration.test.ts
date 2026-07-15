import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../src/engine/session.js";
import type {
  CronDaemonBridge,
  ProviderDaemonDeleteInput,
  ProviderDaemonDeleteResult,
} from "../../src/input/cron-daemon-bridge.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { UserConfigStore, type PicoUserConfig } from "../../src/input/user-config-store.js";
import {
  CredentialNotFoundError,
  credentialRefForModelRoute,
  credentialRefForProvider,
  type CredentialRef,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../../src/provider/effective-model-runtime.js";
import { loadModelRouter } from "../../src/provider/model-router.js";

afterEach(() => vi.unstubAllGlobals());

describe("effective model runtime integration", () => {
  it("keeps explicit secret injection authoritative while the effective loader resolves env first", async () => {
    const direct = await loadModelRouter({
      config: {
        model: "shared/user-model",
        providers: userProviderConfig().providers,
      },
      env: { SHARED_API_KEY: "ambient-secret" },
      legacyProvider: "openai",
      legacyModel: "fallback",
      resolvedSecrets: { providers: { shared: "explicit-secret" } },
    });
    expect(direct.providerConfig("shared/user-model").config.apiKey).toBe("explicit-secret");

    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-env-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-env-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    const vault = new MemoryCredentialVault();
    await vault.put(
      credentialRefForProvider({
        providerId: "shared",
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
      }),
      "vault-secret",
    );
    const effective = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: { SHARED_API_KEY: "loader-env-secret" },
      userConfigStore: store,
      credentialVault: vault,
    });
    expect(effective.router.providerConfig("shared/user-model").config.apiKey).toBe(
      "loader-env-secret",
    );
    expect(effective.credentials.shared?.state).toBe("environment");
  });

  it("uses a v2 provider credential for router execution and /compact without LLM env", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-runtime-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-runtime-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    const vault = new MemoryCredentialVault();
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await vault.put(ref, "vault-only-secret");

    const runtime = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "built-in-fallback",
      env: {},
      userConfigStore: store,
      credentialVault: vault,
    });
    expect(runtime.router.providerConfig("shared/user-model").config.apiKey).toBe(
      "vault-only-secret",
    );
    expect(runtime.credentials.shared?.state).toBe("keychain");

    const authorization: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        authorization.push(new Headers(init?.headers).get("Authorization") ?? "");
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "compact summary" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const session = new Session("vault-compact", workDir, { persistence: false });
    for (let index = 0; index < 8; index++) {
      session.append({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${index}:${"context ".repeat(80)}`,
      });
    }
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "user-model",
      modelRouteId: "shared/user-model",
      modelRouter: runtime.router,
      session,
      userConfigStore: store,
      credentialVault: vault,
      effectiveConfig: runtime.config,
      providerCredentialStatuses: runtime.credentials,
      credentialEnv: {},
    });
    const compact = await processUserInput("/compact", { registry });

    expect(compact.type).toBe("local-command");
    if (compact.type !== "local-command") return;
    expect(compact.result.message).toContain("Compact complete");
    expect(authorization).toEqual(["Bearer vault-only-secret"]);
    expect(JSON.stringify(compact)).not.toContain("vault-only-secret");
  });

  it("uses the v2 credential for OpenAI model discovery", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-discovery-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-discovery-home-"));
    const store = new UserConfigStore({ picoHome });
    const config = userProviderConfig();
    await writeUserConfig(store, {
      ...config,
      providers: {
        shared: { ...config.providers.shared!, models: [], discoverModels: true },
      },
    });
    const vault = new MemoryCredentialVault();
    await vault.put(
      credentialRefForProvider({
        providerId: "shared",
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
      }),
      "discovery-secret",
    );
    let authorization = "";
    const runtime = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: {},
      userConfigStore: store,
      credentialVault: vault,
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(JSON.stringify({ data: [{ id: "discovered-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(authorization).toBe("Bearer discovery-secret");
    expect(runtime.router.routes.map((route) => route.id)).toEqual(["shared/discovered-model"]);
    expect(JSON.stringify(runtime.config)).not.toContain("discovery-secret");
  });

  it("keeps a matching user v2 credential when a trusted project overrides the provider models", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-overlay-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-overlay-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "shared/project-model",
        providers: {
          shared: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1/",
            apiKeyEnv: "PROJECT_API_KEY",
            models: ["project-model"],
            discoverModels: false,
          },
        },
      }),
    );
    const vault = new MemoryCredentialVault();
    await vault.put(
      credentialRefForProvider({
        providerId: "shared",
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
      }),
      "shared-v2-secret",
    );

    const runtime = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: {},
      userConfigStore: store,
      credentialVault: vault,
    });

    expect(runtime.router.providerConfig("shared/project-model").config.apiKey).toBe(
      "shared-v2-secret",
    );
    expect(runtime.credentials.shared).toMatchObject({
      configSource: "project-legacy",
      state: "keychain",
    });
  });

  it("resolves trusted project legacy providers only through exact v1 route refs", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-v1-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-v1-home-"));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "project/project-model",
        providers: {
          project: {
            protocol: "openai",
            baseURL: "https://project.example.test/v1",
            apiKeyEnv: "PROJECT_API_KEY",
            models: ["project-model"],
            discoverModels: false,
          },
        },
      }),
    );
    const vault = new MemoryCredentialVault();
    await vault.put(
      credentialRefForModelRoute(
        {
          id: "project/project-model",
          provider: "openai",
          baseURL: "https://project.example.test/v1",
          model: "project-model",
          apiKeyEnv: "PROJECT_API_KEY",
        },
        workDir,
      ),
      "strict-v1-secret",
    );

    const runtime = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: {},
      picoHome,
      credentialVault: vault,
    });

    expect(runtime.router.providerConfig("project/project-model").config.apiKey).toBe(
      "strict-v1-secret",
    );
    expect(runtime.credentials.project).toMatchObject({
      state: "keychain",
      configSource: "project-legacy",
    });
  });

  it("previews and confirms env import without projecting the secret", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-provider-import-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-provider-import-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, { version: 1, defaults: { mode: "auto" }, providers: {} });
    const vault = new MemoryCredentialVault();
    const env = {
      LLM_BASE_URL: "https://import.example.test/v1",
      LLM_MODEL: "import-model",
      LLM_MODELS: "import-model,other-model",
      LLM_API_KEY: "must-never-be-rendered",
    };
    const daemon = providerDeleteBridge(async ({ providerId, expectedRevision }) => {
      const current = await store.read();
      if (current.revision !== expectedRevision) {
        return { status: "rejected", message: "CONFIG_REVISION_CONFLICT" };
      }
      const provider = current.config.providers[providerId];
      if (!provider) return { status: "rejected", message: "Provider not found" };
      const providers = { ...current.config.providers };
      delete providers[providerId];
      const written = await store.write(
        { ...current.config, providers },
        { expectedRevision },
      );
      await vault.delete(
        credentialRefForProvider({
          providerId,
          protocol: provider.protocol,
          baseURL: provider.baseURL,
        }),
      );
      return {
        status: "deleted",
        revision: written.revision,
        message: `Shared user provider ${providerId} deleted.`,
      };
    });
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "fallback",
      userConfigStore: store,
      credentialVault: vault,
      credentialEnv: env,
      cronDaemonBridge: daemon,
      effectiveConfig: {
        defaults: {},
        providers: {},
        sources: {},
        revisions: { user: "startup-user", project: "startup-project" },
      },
    });

    const preview = await processUserInput("/provider import-env imported", { registry });
    expect(JSON.stringify(preview)).not.toContain(env.LLM_API_KEY);
    expect((await store.read()).config.providers).toEqual({});

    const confirmed = await processUserInput("/provider import-env imported --confirm", {
      registry,
    });
    const file = await readFile(join(picoHome, "config.json"), "utf8");
    expect(JSON.stringify(confirmed)).not.toContain(env.LLM_API_KEY);
    expect(file).not.toContain(env.LLM_API_KEY);
    expect(JSON.parse(file)).toMatchObject({
      defaults: { modelRouteId: "imported/import-model", mode: "auto" },
      providers: {
        imported: {
          baseURL: env.LLM_BASE_URL,
          apiKeyEnv: "LLM_API_KEY",
          models: ["import-model", "other-model"],
        },
      },
    });
    await expect(
      vault.resolve(
        credentialRefForProvider({
          providerId: "imported",
          protocol: "openai",
          baseURL: env.LLM_BASE_URL,
        }),
      ),
    ).resolves.toBe(env.LLM_API_KEY);

    const listed = await processUserInput("/provider list", { registry });
    expect(JSON.stringify(listed)).toContain("imported");
    expect(JSON.stringify(listed)).not.toContain(env.LLM_API_KEY);

    const changedDefault = await processUserInput("/provider default imported/other-model", {
      registry,
    });
    expect(JSON.stringify(changedDefault)).not.toContain(env.LLM_API_KEY);
    expect((await store.read()).config.defaults).toEqual({
      mode: "auto",
      modelRouteId: "imported/other-model",
    });

    const clearedDefault = await processUserInput("/provider default clear", { registry });
    expect(JSON.stringify(clearedDefault)).toContain("default model cleared");

    const deleted = await processUserInput("/provider delete imported", { registry });
    expect(JSON.stringify(deleted)).not.toContain(env.LLM_API_KEY);
    const afterDelete = await store.read();
    expect(afterDelete.config.providers).toEqual({});
    expect(afterDelete.config.defaults).toEqual({ mode: "auto" });
    const listedAfterDelete = await processUserInput("/provider list", { registry });
    expect(JSON.stringify(listedAfterDelete)).not.toContain("imported");
    await expect(
      vault.has(
        credentialRefForProvider({
          providerId: "imported",
          protocol: "openai",
          baseURL: env.LLM_BASE_URL,
        }),
      ),
    ).resolves.toBe(false);
  });

  it("keeps a provider visible when vault import fails and keeps config when vault deletion fails", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-provider-failure-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-provider-failure-home-"));
    const store = new UserConfigStore({ picoHome });
    const importVault = new FailingPutCredentialVault();
    const secret = "must-not-appear-in-failure";
    const importRegistry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "fallback",
      userConfigStore: store,
      credentialVault: importVault,
      credentialEnv: {
        LLM_BASE_URL: "https://failure.example.test/v1/",
        LLM_MODEL: "failure-model",
        LLM_API_KEY: secret,
      },
    });

    const failedImport = await processUserInput("/provider import-env failure --confirm", {
      registry: importRegistry,
    });
    expect(JSON.stringify(failedImport)).not.toContain(secret);
    expect((await store.read()).config.providers.failure?.baseURL).toBe(
      "https://failure.example.test/v1",
    );

    const stored = await store.read();
    await store.write(userProviderConfig(), { expectedRevision: stored.revision });
    const deleteVault = new FailingDeleteCredentialVault();
    await deleteVault.put(
      credentialRefForProvider({
        providerId: "shared",
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
      }),
      secret,
    );
    const deleteRegistry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "fallback",
      userConfigStore: store,
      credentialVault: deleteVault,
      cronDaemonBridge: providerDeleteBridge(async () => ({
        status: "rejected",
        message:
          "Shared user provider shared was not deleted because its OS vault credential could not be removed.",
      })),
      credentialEnv: {},
    });
    const failedDelete = await processUserInput("/provider delete shared", {
      registry: deleteRegistry,
    });
    expect(JSON.stringify(failedDelete)).not.toContain(secret);
    expect((await store.read()).config.providers.shared).toBeDefined();
  });

  it("TUI 在 daemon 不可达时 fail-closed，不直接删配置或凭证", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-provider-offline-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-provider-offline-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    const vault = new MemoryCredentialVault();
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await vault.put(ref, "offline-secret");
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "user-model",
      userConfigStore: store,
      credentialVault: vault,
      credentialEnv: {},
      cronDaemonBridge: providerDeleteBridge(async () => ({
        status: "unavailable",
        message: "Local Runtime daemon is unavailable; Provider deletion is fail-closed.",
      })),
    });

    const result = await processUserInput("/provider delete shared", { registry });
    expect(JSON.stringify(result)).toContain("fail-closed");
    expect((await store.read()).config.providers.shared).toBeDefined();
    await expect(vault.has(ref)).resolves.toBe(true);
  });

  it("TUI 将读到的 revision 交给 daemon，OCC 冲突后保留 Provider 与凭证", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-provider-occ-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-provider-occ-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    const vault = new MemoryCredentialVault();
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await vault.put(ref, "occ-secret");
    let receivedRevision = "";
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "user-model",
      userConfigStore: store,
      credentialVault: vault,
      credentialEnv: {},
      cronDaemonBridge: providerDeleteBridge(async (input) => {
        receivedRevision = input.expectedRevision;
        const current = await store.read();
        await store.write(
          { ...current.config, defaults: { ...current.config.defaults, mode: "plan" } },
          { expectedRevision: current.revision },
        );
        return { status: "rejected", message: "CONFIG_REVISION_CONFLICT" };
      }),
    });
    const before = await store.read();

    const result = await processUserInput("/provider delete shared", { registry });
    expect(receivedRevision).toBe(before.revision);
    expect(JSON.stringify(result)).toContain("CONFIG_REVISION_CONFLICT");
    expect((await store.read()).config.providers.shared).toBeDefined();
    await expect(vault.has(ref)).resolves.toBe(true);
  });
});

function providerDeleteBridge(
  deleteProvider: (
    input: ProviderDaemonDeleteInput,
  ) => Promise<ProviderDaemonDeleteResult>,
): CronDaemonBridge {
  return {
    registerWorkspace: async () => ({ available: true, message: "registered" }),
    statusWorkspace: async () => ({ available: true, registered: true, message: "connected" }),
    deleteProvider,
  };
}

class MemoryCredentialVault implements CredentialVault {
  private readonly values = new Map<CredentialRef, string>();

  capability() {
    return {
      available: true,
      backend: "macos-keychain" as const,
      diagnostic: "memory test vault",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    this.values.set(ref, secret);
  }

  async resolve(ref: CredentialRef): Promise<string> {
    const secret = this.values.get(ref);
    if (!secret) throw new CredentialNotFoundError(ref);
    return secret;
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.values.has(ref);
  }

  async delete(ref: CredentialRef): Promise<void> {
    this.values.delete(ref);
  }
}

class FailingPutCredentialVault extends MemoryCredentialVault {
  override async put(): Promise<void> {
    throw new Error("vault write rejected");
  }
}

class FailingDeleteCredentialVault extends MemoryCredentialVault {
  override async delete(): Promise<void> {
    throw new Error("vault delete rejected");
  }
}

function userProviderConfig(): PicoUserConfig {
  return {
    version: 1,
    defaults: { modelRouteId: "shared/user-model" },
    providers: {
      shared: {
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
        apiKeyEnv: "SHARED_API_KEY",
        models: ["user-model"],
        discoverModels: false,
      },
    },
  };
}

async function writeUserConfig(store: UserConfigStore, config: PicoUserConfig): Promise<void> {
  const current = await store.read();
  await store.write(config, { expectedRevision: current.revision });
}
