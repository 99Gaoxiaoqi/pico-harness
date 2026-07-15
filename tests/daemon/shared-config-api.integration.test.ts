import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
  createProductionLocalDaemonHost,
  DesktopAutomationService,
  DesktopRuntimeService,
  LocalRuntimeClient,
  RUNTIME_ERROR_CODES,
  resolveLocalDaemonEndpoint,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import {
  credentialRefForModelRoute,
  credentialRefForProvider,
  parseAnyCredentialRef,
  type CredentialRef,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { CronService } from "../../src/tasks/cron-service.js";
import type { YoloPolicySnapshot } from "../../src/tasks/runtime-types.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
  type RunAgentCliResult,
} from "../../src/runtime/agent-runtime.js";

describe("Desktop shared configuration API integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("App 配置一次后共享 Provider、OCC 和凭证状态，且结果与事件不回显 secret", async () => {
    const fixture = await createFixture();
    const observed: unknown[] = [];
    const unsubscribe = fixture.service.subscribe((event) => observed.push(event));

    const initial = (await fixture.service.handle(createRuntimeRequest("config.user.get", {}))) as {
      revision: string;
    };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as {
      revision: string;
      provider: { fingerprint: string; credentialStatus: string };
    };
    expect(upserted.provider).toMatchObject({ credentialStatus: "missing" });

    const secret = "never-return-this-desktop-secret";
    const credential = await fixture.service.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: "shared",
        secret,
        expectedProviderFingerprint: upserted.provider.fingerprint,
      }),
    );
    expect(JSON.stringify(credential)).not.toContain(secret);

    const listed = (await fixture.service.handle(createRuntimeRequest("provider.list", {}))) as {
      revision: string;
      providers: Array<{
        id: string;
        origin: string;
        credentialStatus: string;
        credentialSource: string;
        fingerprint: string;
      }>;
    };
    expect(listed.providers).toEqual([
      expect.objectContaining({
        id: "shared",
        origin: "user",
        credentialStatus: "ready",
        credentialSource: "keychain",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    await writeFile(
      join(fixture.workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "shared/coder",
        providers: {
          shared: projectProvider("https://provider.example.test/v1"),
          project: {
            ...projectProvider("https://project.example.test/v1"),
            apiKeyEnv: "PROJECT_ONLY_KEY",
          },
        },
      }),
    );
    const effective = (await fixture.service.handle(
      createRuntimeRequest("config.effective.get", { workspacePath: fixture.workspace }),
    )) as {
      config: {
        providers: Array<{
          id: string;
          origin: string;
          credentialStatus: string;
          credentialSource: string;
        }>;
      };
    };
    expect(effective.config.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "shared",
          origin: "project-legacy",
          credentialStatus: "ready",
          credentialSource: "keychain",
        }),
        expect.objectContaining({
          id: "project",
          origin: "project-legacy",
          credentialStatus: "unsupported",
          credentialSource: "none",
        }),
      ]),
    );

    await expect(
      fixture.service.handle(
        createRuntimeRequest("config.user.update", {
          defaults: { modelRouteId: "shared/coder", mode: "auto" },
          expectedRevision: initial.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });

    const updatedDefaults = (await fixture.service.handle(
      createRuntimeRequest("config.user.update", {
        defaults: { modelRouteId: "shared/coder", mode: "auto" },
        expectedRevision: listed.revision,
      }),
    )) as { revision: string };

    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.upsert", {
          provider: providerInput("https://changed.example.test/v1"),
          expectedRevision: updatedDefaults.revision,
        }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("先删除凭证"),
    });

    await fixture.service.handle(
      createRuntimeRequest("provider.credential.delete", {
        providerId: "shared",
        expectedProviderFingerprint: listed.providers[0]!.fingerprint,
      }),
    );
    const moved = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://changed.example.test/v1"),
        expectedRevision: updatedDefaults.revision,
      }),
    )) as {
      revision: string;
      provider: { fingerprint: string; credentialStatus: string };
    };
    expect(moved.provider).toMatchObject({ credentialStatus: "missing" });
    expect(moved.provider.fingerprint).not.toBe(upserted.provider.fingerprint);

    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.delete", {
          providerId: "shared",
          expectedRevision: moved.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });

    const external = new UserConfigStore({ picoHome: fixture.picoHome });
    const beforeExternal = await external.read();
    const externalWrite = await external.write(
      {
        ...beforeExternal.config,
        providers: {
          ...beforeExternal.config.providers,
          external: {
            protocol: "openai",
            baseURL: "https://external.example.test/v1",
            apiKeyEnv: "EXTERNAL_KEY",
            models: ["reviewer"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: beforeExternal.revision },
    );
    await expect
      .poll(
        () =>
          observed.some(
            (event) =>
              isRecord(event) &&
              event["topic"] === "config.updated" &&
              isRecord(event["payload"]) &&
              event["payload"]["revision"] === externalWrite.revision &&
              Array.isArray(event["payload"]["providerIds"]) &&
              event["payload"]["providerIds"].includes("external"),
          ),
        { timeout: 3_000 },
      )
      .toBe(true);

    expect(JSON.stringify(observed)).not.toContain(secret);
    expect(await readFile(join(fixture.picoHome, "config.json"), "utf8")).not.toContain(secret);
    unsubscribe();
  });

  it("环境凭证优先于 v2 Keychain，并拒绝动态-only Provider", async () => {
    const fixture = await createFixture({ env: { SHARED_KEY: "environment-secret" } });
    const initial = (await fixture.service.handle(createRuntimeRequest("config.user.get", {}))) as {
      revision: string;
    };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as { provider: { fingerprint: string } };
    await fixture.service.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: "shared",
        secret: "keychain-secret",
        expectedProviderFingerprint: upserted.provider.fingerprint,
      }),
    );
    await expect(
      fixture.service.handle(createRuntimeRequest("provider.list", {})),
    ).resolves.toMatchObject({
      providers: [
        expect.objectContaining({
          credentialStatus: "environment",
          credentialSource: "environment",
        }),
      ],
    });
    for (const provider of [
      { ...providerInput("https://provider.example.test/v1"), models: [] },
      {
        ...providerInput("https://provider.example.test/v1"),
        protocol: "claude",
        discoverModels: true,
      },
    ]) {
      await expect(
        fixture.service.handle(
          createRuntimeRequest("provider.upsert", {
            provider,
            expectedRevision: initial.revision,
          }),
        ),
      ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.INVALID_PARAMS });
    }
  });

  it("Provider 带 v2 凭证可一键删除，OCC 失败时不会先丢失 secret", async () => {
    const fixture = await createFixture();
    const initial = (await fixture.service.handle(
      createRuntimeRequest("config.user.get", {}),
    )) as { revision: string };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as { revision: string; provider: { fingerprint: string } };
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await fixture.service.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: "shared",
        secret: "delete-me-only-after-occ",
        expectedProviderFingerprint: upserted.provider.fingerprint,
      }),
    );

    const external = await fixture.userConfigStore.read();
    const changed = await fixture.userConfigStore.write(
      {
        ...external.config,
        providers: {
          ...external.config.providers,
          other: {
            protocol: "openai",
            baseURL: "https://other.example.test/v1",
            apiKeyEnv: "OTHER_KEY",
            models: ["reviewer"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: external.revision },
    );
    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.delete", {
          providerId: "shared",
          expectedRevision: upserted.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: RUNTIME_ERROR_CODES.CONFLICT });
    await expect(fixture.credentialVault.has(ref)).resolves.toBe(true);
    expect((await fixture.userConfigStore.read()).config.providers.shared).toBeDefined();

    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.delete", {
          providerId: "shared",
          expectedRevision: changed.revision,
        }),
      ),
    ).resolves.toMatchObject({ deleted: true, revision: expect.any(String) });
    await expect(fixture.credentialVault.has(ref)).resolves.toBe(false);
    expect((await fixture.userConfigStore.read()).config.providers).toEqual({
      other: expect.any(Object),
    });
  });

  it("凭证库删除失败时恢复 Provider 配置并保留凭证", async () => {
    const vault = new FailingDeleteCredentialVault();
    const fixture = await createFixture({ credentialVault: vault });
    const initial = (await fixture.service.handle(
      createRuntimeRequest("config.user.get", {}),
    )) as { revision: string };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as { revision: string; provider: { fingerprint: string } };
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await fixture.service.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: "shared",
        secret: "must-survive-compensation",
        expectedProviderFingerprint: upserted.provider.fingerprint,
      }),
    );

    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.delete", {
          providerId: "shared",
          expectedRevision: upserted.revision,
        }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("配置已安全恢复"),
    });
    expect((await fixture.userConfigStore.read()).config.providers.shared).toBeDefined();
    await expect(vault.has(ref)).resolves.toBe(true);
  });

  it("活动 Run 期间拒绝删除 Provider 凭证或注销工作区", async () => {
    let releaseRun!: () => void;
    const blockedRun = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const fixture = await createFixture({ execute: async () => blockedRun });
    const initial = (await fixture.service.handle(
      createRuntimeRequest("config.user.get", {}),
    )) as { revision: string };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as { provider: { fingerprint: string } };
    await fixture.service.handle(
      createRuntimeRequest("run.start", {
        workspacePath: fixture.workspace,
        prompt: "keep this run active",
      }),
    );
    await expect
      .poll(async () => {
        const listed = (await fixture.service.handle(
          createRuntimeRequest("runs.list", { workspacePath: fixture.workspace }),
        )) as { runs: Array<{ status: string }> };
        return listed.runs.some((run) => run.status === "running");
      })
      .toBe(true);

    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.credential.delete", {
          providerId: "shared",
          expectedProviderFingerprint: upserted.provider.fingerprint,
        }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("活动 Run"),
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("workspace.unregister", { workspacePath: fixture.workspace }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("活动 Run"),
    });
    await expect(fixture.registration.list()).resolves.toContain(fixture.workspace);
    releaseRun();
    await expect
      .poll(async () => {
        const listed = (await fixture.service.handle(
          createRuntimeRequest("runs.list", { workspacePath: fixture.workspace }),
        )) as { runs: Array<{ status: string }> };
        return listed.runs.every((run) => run.status !== "running");
      })
      .toBe(true);
  });

  it("持久化 v2 Automation 固定 modelRouteId、兼容 v1 反推，并阻断删除被启用的 Provider", async () => {
    const v2Ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    const fixture = await createFixture({
      automationSecurity: { credentialRef: v2Ref, modelRouteId: "shared/coder" },
    });
    const initial = (await fixture.service.handle(createRuntimeRequest("config.user.get", {}))) as {
      revision: string;
    };
    const upserted = (await fixture.service.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput("https://provider.example.test/v1"),
        expectedRevision: initial.revision,
      }),
    )) as { revision: string; provider: { fingerprint: string } };
    const created = (await fixture.service.handle(
      createRuntimeRequest("jobs.create", {
        workspacePath: fixture.workspace,
        name: "Shared provider job",
        prompt: "review repository",
        schedule: "0 9 * * 1-5",
      }),
    )) as { job: { jobId: string; modelRouteId: string } };
    expect(created.job).toMatchObject({ modelRouteId: "shared/coder" });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.credential.delete", {
          providerId: "shared",
          expectedProviderFingerprint: upserted.provider.fingerprint,
        }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("Automation"),
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("provider.delete", {
          providerId: "shared",
          expectedRevision: upserted.revision,
        }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("Automation"),
    });
    await expect(
      fixture.service.handle(
        createRuntimeRequest("workspace.unregister", { workspacePath: fixture.workspace }),
      ),
    ).rejects.toMatchObject({
      code: RUNTIME_ERROR_CODES.CONFLICT,
      message: expect.stringContaining("Automation"),
    });
    await expect(fixture.registration.list()).resolves.toContain(fixture.workspace);

    const cron = new CronService({ workDir: fixture.workspace });
    const persistedV2 = cron.store.getCronJob(created.job.jobId)!;
    expect(persistedV2.modelRouteId).toBe("shared/coder");
    expect(parseAnyCredentialRef(persistedV2.credentialRef!)).toMatchObject({ version: "v2" });
    const v1Ref = credentialRefForModelRoute(
      {
        id: "legacy/coder",
        provider: "openai",
        baseURL: "https://legacy.example.test/v1",
        model: "coder",
        apiKeyEnv: "LEGACY_KEY",
      },
      fixture.workspace,
    );
    const legacy = cron.create({
      workspacePath: fixture.workspace,
      name: "Legacy v1 job",
      prompt: "legacy review",
      schedule: "0 10 * * *",
      enabled: false,
      credentialRef: v1Ref,
      policySnapshot: policy(),
    });
    expect(legacy.modelRouteId).toBe("legacy/coder");
    expect(parseAnyCredentialRef(legacy.credentialRef!)).toMatchObject({ version: "v1" });
    cron.close();
  });

  it("生产 daemon 将同一 UserConfigStore 与 Vault 注入 Automation 并创建 v2 Job", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcfg-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workspace, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(canonicalWorkspace);
    const userConfigStore = new UserConfigStore({ picoHome });
    const initial = await userConfigStore.read();
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: "shared/coder" },
        providers: {
          shared: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "SHARED_KEY",
            models: ["coder"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initial.revision },
    );
    const vault = new MemoryCredentialVault();
    const credentialRef = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example.test/v1",
    });
    await vault.put(credentialRef, "production-secret");
    const registration = new WorkspaceRegistrationStore(join(picoHome, "daemon-workspaces.json"));
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "r"),
      userIdentity: "shared-config-production",
      picoHome,
    });
    const host = createProductionLocalDaemonHost({
      endpoint,
      env: { PICO_HOME: picoHome },
      trustStore: trust,
      registrationStore: registration,
      userConfigStore,
      credentialVault: vault,
    });
    await host.start();
    const client = new LocalRuntimeClient(endpoint);
    let jobId: string;
    try {
      const created = (await client.request("jobs.create", {
        workspacePath: canonicalWorkspace,
        name: "Shared provider production job",
        prompt: "review repository",
        schedule: "0 9 * * 1-5",
      })) as { job: { jobId: string; modelRouteId: string } };
      jobId = created.job.jobId;
      expect(created.job.modelRouteId).toBe("shared/coder");
    } finally {
      client.close();
      await host.stop();
    }
    const cron = new CronService({ workDir: canonicalWorkspace });
    const job = cron.store.getCronJob(jobId)!;
    expect(job.modelRouteId).toBe("shared/coder");
    expect(parseAnyCredentialRef(job.credentialRef!)).toMatchObject({
      version: "v2",
      providerId: "shared",
    });
    cron.close();
    await rm(root, { recursive: true, force: true });
  });

  it("生产 Desktop 新会话与前台执行复用用户默认 Provider 和 v2 凭证", async () => {
    const root = await mkdtemp(join(tmpdir(), "pcfg-run-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workspace, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(canonicalWorkspace);
    const userConfigStore = new UserConfigStore({ picoHome });
    const initial = await userConfigStore.read();
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: "shared/coder", mode: "auto" },
        providers: {
          shared: {
            protocol: "openai",
            baseURL: "https://provider.example.test/v1",
            apiKeyEnv: "SHARED_KEY",
            models: ["coder"],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: initial.revision },
    );
    const vault = new MemoryCredentialVault();
    await vault.put(
      credentialRefForProvider({
        providerId: "shared",
        protocol: "openai",
        baseURL: "https://provider.example.test/v1",
      }),
      "shared-runtime-secret",
    );
    const endpoint = resolveLocalDaemonEndpoint({
      runtimeDir: join(root, "runtime"),
      userIdentity: "shared-config-foreground",
      picoHome,
    });
    const runtime = new CapturingAgentRuntime();
    const host = createProductionLocalDaemonHost({
      endpoint,
      env: { PICO_HOME: picoHome },
      trustStore: trust,
      registrationStore: new WorkspaceRegistrationStore(join(picoHome, "daemon-workspaces.json")),
      userConfigStore,
      credentialVault: vault,
      agentRuntime: runtime,
    });
    await host.start();
    const client = new LocalRuntimeClient(endpoint);
    try {
      const created = (await client.request("session.create", {
        workspacePath: canonicalWorkspace,
      })) as { session: { sessionId: string } };
      await expect(
        client.request("session.settings.get", {
          workspacePath: canonicalWorkspace,
          sessionId: created.session.sessionId,
        }),
      ).resolves.toMatchObject({
        settings: {
          provider: "openai",
          model: "coder",
          modelRouteId: "shared/coder",
          mode: "auto",
        },
      });
      await client.request("run.start", {
        workspacePath: canonicalWorkspace,
        sessionId: created.session.sessionId,
        prompt: "检查共享配置",
      });
      await expect.poll(() => runtime.requests.length).toBe(1);
      expect(runtime.requests[0]).toMatchObject({
        session: created.session.sessionId,
        provider: "openai",
        model: "coder",
        modelRouteId: "shared/coder",
        baseURL: "https://provider.example.test/v1",
        apiKey: "shared-runtime-secret",
      });
      expect(runtime.modelRoutes).toEqual([["shared/coder"]]);
    } finally {
      client.close();
      await host.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  async function createFixture(
    options: {
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly automationSecurity?: {
        readonly credentialRef: CredentialRef;
        readonly modelRouteId: string;
      };
      readonly credentialVault?: CredentialVault;
      readonly execute?: ConstructorParameters<typeof WorkspaceRuntimeService>[0]["execute"];
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "pico-shared-config-api-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    const env = { ...options.env, PICO_HOME: picoHome };
    const registration = new WorkspaceRegistrationStore(join(picoHome, "daemon-workspaces.json"));
    await registration.register(canonicalWorkspace);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(canonicalWorkspace);
    const userConfigStore = new UserConfigStore({ picoHome });
    const effectiveConfigResolver = new EffectiveConfigResolver({ userConfigStore });
    const credentialVault = options.credentialVault ?? new MemoryCredentialVault();
    const runtime = new WorkspaceRuntimeService({
      execute: options.execute ?? (async () => undefined),
      registrationStore: registration,
      env,
    });
    const automations = options.automationSecurity
      ? new DesktopAutomationService({
          prepareSecurity: async () => ({
            ...options.automationSecurity!,
            policySnapshot: policy(),
          }),
          ensureWorkspaceRuntime: async () => undefined,
          runNow: async (workDir, jobId) => {
            const cron = new CronService({ workDir });
            try {
              return cron.runNow(jobId);
            } finally {
              cron.close();
            }
          },
        })
      : undefined;
    const service = new DesktopRuntimeService({
      runtimeService: runtime,
      registrationStore: registration,
      trustStore: trust,
      userConfigStore,
      effectiveConfigResolver,
      credentialVault,
      ...(automations ? { automations } : {}),
      env,
    });
    cleanups.push(async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    });
    return {
      root,
      workspace: canonicalWorkspace,
      picoHome,
      registration,
      trust,
      userConfigStore,
      credentialVault,
      runtime,
      service,
    };
  }
});

function providerInput(baseURL: string) {
  return {
    id: "shared",
    protocol: "openai" as const,
    baseURL,
    apiKeyEnv: "SHARED_KEY",
    models: ["coder"],
    discoverModels: false,
  };
}

function projectProvider(baseURL: string) {
  const { id: _id, ...provider } = providerInput(baseURL);
  return provider;
}

function policy(): YoloPolicySnapshot {
  return {
    mode: "yolo",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy: "disabled",
    allowedTools: [],
    hardlineVersion: "builtin-v1",
    hookVersion: "workspace-v1",
    createdAt: 100,
  };
}

class MemoryCredentialVault implements CredentialVault {
  private readonly secrets = new Map<CredentialRef, string>();

  capability() {
    return {
      available: true,
      backend: "macos-keychain" as const,
      diagnostic: "memory vault",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    this.secrets.set(ref, secret);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.secrets.has(ref);
  }

  async delete(ref: CredentialRef): Promise<void> {
    this.secrets.delete(ref);
  }

  async resolve(ref: CredentialRef): Promise<string> {
    const secret = this.secrets.get(ref);
    if (!secret) throw new Error("credential missing");
    return secret;
  }
}

class FailingDeleteCredentialVault extends MemoryCredentialVault {
  override async delete(_ref: CredentialRef): Promise<void> {
    throw new Error("simulated credential vault delete failure");
  }
}

class CapturingAgentRuntime extends AgentRuntime {
  readonly requests: RunAgentCliOptions[] = [];
  readonly modelRoutes: string[][] = [];

  override async execute(
    options: RunAgentCliOptions,
    _dependencies: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    this.requests.push(options);
    this.modelRoutes.push(_dependencies.modelRouter?.routes.map((route) => route.id) ?? []);
    const sessionId = options.session ?? "shared-config-session";
    return {
      sessionId,
      sessionSelection: { mode: "resume", sessionId },
      workDir: options.dir ?? process.cwd(),
      finalMessage: "shared configuration applied",
      usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
      messages: [],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
