import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../../src/engine/session.js";
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

  it("在下一安全边界重新解析 config 与 Keychain，不复用旧 secret", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-effective-reload-work-"));
    const picoHome = await mkdtemp(join(tmpdir(), "pico-effective-reload-home-"));
    const store = new UserConfigStore({ picoHome });
    await writeUserConfig(store, userProviderConfig());
    const vault = new MemoryCredentialVault();
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await vault.put(ref, "first-keychain-secret");

    const first = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: {},
      userConfigStore: store,
      credentialVault: vault,
    });
    expect(first.router.providerConfig("shared/user-model").config.apiKey).toBe(
      "first-keychain-secret",
    );

    const current = await store.read();
    await store.write(
      {
        ...current.config,
        defaults: { ...current.config.defaults, modelRouteId: "shared/model-b" },
        providers: {
          ...current.config.providers,
          shared: {
            ...current.config.providers.shared!,
            models: ["user-model", "model-b"],
          },
        },
      },
      { expectedRevision: current.revision },
    );
    await vault.put(ref, "rotated-keychain-secret");

    const refreshed = await loadEffectiveModelRuntime({
      workDir,
      projectTrusted: true,
      legacyProvider: "openai",
      legacyModel: "fallback",
      env: {},
      userConfigStore: store,
      credentialVault: vault,
    });
    expect(refreshed.config.defaultModelRouteId).toBe("shared/model-b");
    expect(refreshed.router.routes.map((route) => route.id)).toEqual([
      "shared/user-model",
      "shared/model-b",
    ]);
    expect(refreshed.router.providerConfig("shared/model-b").config.apiKey).toBe(
      "rotated-keychain-secret",
    );
    expect(JSON.stringify(refreshed.config)).not.toContain("rotated-keychain-secret");
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
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "fallback",
      userConfigStore: store,
      credentialVault: vault,
      credentialEnv: env,
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
      credentialEnv: {},
    });
    const failedDelete = await processUserInput("/provider delete shared", {
      registry: deleteRegistry,
    });
    expect(JSON.stringify(failedDelete)).not.toContain(secret);
    expect((await store.read()).config.providers.shared).toBeDefined();
  });
});

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
