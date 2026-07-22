import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { WorkspaceRegistrationStore } from "../../src/daemon/workspace-registration.js";
import { EffectiveConfigResolver } from "../../src/input/effective-config.js";
import { loadPicoProjectConfig } from "../../src/input/pico-config.js";
import {
  EMPTY_USER_CONFIG_REVISION,
  UserConfigStore,
  type PicoUserConfig,
} from "../../src/input/user-config-store.js";
import {
  CredentialNotFoundError,
  credentialRefForProvider,
  type CredentialRef,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { loadEffectiveModelRuntime } from "../../src/provider/effective-model-runtime.js";

const PROVIDER_ID = "config-key-fixture";
const MODEL_ID = "fixture-model";
const API_KEY_ENV = "PICO_CONFIG_KEY_FIXTURE_ENV";

test("Desktop credential API persists a user-config API key without projecting plaintext", async (context) => {
  const fixture = await createDesktopFixture("desktop-write");
  context.after(fixture.dispose);
  const secret = syntheticSecret("desktop-write");
  const notifications: unknown[] = [];
  const unsubscribe = fixture.desktop.subscribe((notification) => notifications.push(notification));
  context.after(unsubscribe);
  const initialRevision = await readPublicUserRevision(fixture.desktop);

  const upserted = asRecord(
    await fixture.desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput(),
        expectedRevision: initialRevision,
      }),
    ),
  );
  const providerRevision = requiredString(upserted["revision"], "provider revision");
  const setResult = await fixture.desktop.handle(
    createRuntimeRequest("provider.credential.set", {
      providerId: PROVIDER_ID,
      secret,
      expectedRevision: providerRevision,
    }),
  );

  const raw = await readFile(fixture.userConfig.filePath, "utf8");
  const persisted = asRecord(JSON.parse(raw));
  const persistedProvider = asRecord(asRecord(persisted["providers"])[PROVIDER_ID]);
  assertSecretMatches("persisted user config", persistedProvider["apiKey"], secret);
  assert.equal((await stat(fixture.userConfig.filePath)).mode & 0o777, 0o600);

  const listed = await fixture.desktop.handle(createRuntimeRequest("provider.list", {}));
  const status = await fixture.desktop.handle(
    createRuntimeRequest("provider.credential.status", { providerId: PROVIDER_ID }),
  );
  const userConfigProjection = await fixture.desktop.handle(
    createRuntimeRequest("config.user.get", {}),
  );
  assertSecretAbsent("credential set result", setResult, secret);
  assertSecretAbsent("provider list", listed, secret);
  assertSecretAbsent("credential status", status, secret);
  assertSecretAbsent("user config protocol projection", userConfigProjection, secret);
  assertSecretAbsent("config.updated notifications", notifications, secret);
  assert.equal(fixture.vaultCalls(), 0, "ordinary config-key writes must not require Keychain");
});

test("credential delete is CAS protected and removes only the persisted API key", async (context) => {
  const fixture = await createDesktopFixture("desktop-delete");
  context.after(fixture.dispose);
  const secret = syntheticSecret("desktop-delete");
  const initialRevision = await readPublicUserRevision(fixture.desktop);
  const upserted = asRecord(
    await fixture.desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput(),
        expectedRevision: initialRevision,
      }),
    ),
  );
  const providerRevision = requiredString(upserted["revision"], "provider revision");
  const setResult = asRecord(
    await fixture.desktop.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: PROVIDER_ID,
        secret,
        expectedRevision: providerRevision,
      }),
    ),
  );
  const credentialRevision = requiredString(setResult["revision"], "credential revision");
  assert.notEqual(
    credentialRevision,
    providerRevision,
    "the CAS token must advance when credential state changes",
  );

  let conflict: unknown;
  try {
    await fixture.desktop.handle(
      createRuntimeRequest("provider.credential.delete", {
        providerId: PROVIDER_ID,
        expectedRevision: providerRevision,
      }),
    );
  } catch (error) {
    conflict = error;
  }
  assert.ok(
    conflict instanceof RuntimeProtocolError && conflict.code === RUNTIME_ERROR_CODES.CONFLICT,
  );
  assertSecretAbsent("CAS conflict", serializeError(conflict), secret);
  assertSecretMatches(
    "config after CAS conflict",
    readPersistedApiKey(await readFile(fixture.userConfig.filePath, "utf8")),
    secret,
  );

  const deleted = await fixture.desktop.handle(
    createRuntimeRequest("provider.credential.delete", {
      providerId: PROVIDER_ID,
      expectedRevision: credentialRevision,
    }),
  );
  const raw = await readFile(fixture.userConfig.filePath, "utf8");
  const provider = asRecord(asRecord(asRecord(JSON.parse(raw))["providers"])[PROVIDER_ID]);
  assert.equal(Object.hasOwn(provider, "apiKey"), false);
  assert.equal(provider["baseURL"], "https://example.test/v1");
  assert.equal((await stat(fixture.userConfig.filePath)).mode & 0o777, 0o600);
  assertSecretAbsent("credential delete result", deleted, secret);
  assert.equal(fixture.vaultCalls(), 0, "ordinary config-key deletion must not require Keychain");
});

test("project .pico/config.json rejects plaintext apiKey", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-project-config-key-reject-"));
  const secret = syntheticSecret("project-reject");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pico"), { recursive: true });
  await writeFile(
    join(root, ".pico", "config.json"),
    `${JSON.stringify({
      version: 1,
      providers: {
        [PROVIDER_ID]: {
          ...providerConfig(),
          apiKey: secret,
        },
      },
    })}\n`,
    "utf8",
  );

  let rejection: unknown;
  try {
    await loadPicoProjectConfig(root);
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection instanceof Error, "project apiKey must fail closed");
  assertSecretAbsent("project config rejection", serializeError(rejection), secret);
});

test("effective provider assembly resolves a config key with an empty environment", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-effective-config-key-"));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  const secret = syntheticSecret("effective-runtime");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  const store = new UserConfigStore({ picoHome });
  await store.write(userConfigWithKey(secret), { expectedRevision: EMPTY_USER_CONFIG_REVISION });
  const resolver = new EffectiveConfigResolver({ userConfigStore: store });
  const vault = unavailableVault();

  const runtime = await loadEffectiveModelRuntime({
    workDir: workspace,
    projectTrusted: false,
    legacyProvider: "openai",
    legacyModel: "unused-legacy-model",
    legacyModelExplicit: false,
    env: {},
    userConfigStore: store,
    configResolver: resolver,
    credentialVault: vault,
  });
  const configured = runtime.router.providerConfig(`${PROVIDER_ID}/${MODEL_ID}`);
  assertSecretMatches("process-local provider config", configured.config.apiKey, secret);
  assertSecretAbsent("effective runtime metadata", runtime.config, secret);
  assertSecretAbsent("model route metadata", configured.route, secret);
});

test("legacy environment and Keychain credentials remain compatible fallbacks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-config-key-legacy-"));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });

  const environmentSecret = syntheticSecret("legacy-environment");
  const emptyStore = new UserConfigStore({ picoHome: join(picoHome, "environment") });
  const environmentRuntime = await loadEffectiveModelRuntime({
    workDir: workspace,
    projectTrusted: false,
    legacyProvider: "openai",
    legacyModel: MODEL_ID,
    legacyModelExplicit: true,
    env: {
      LLM_BASE_URL: "https://legacy-environment.example/v1",
      LLM_MODEL: MODEL_ID,
      LLM_API_KEY: environmentSecret,
    },
    userConfigStore: emptyStore,
    configResolver: new EffectiveConfigResolver({ userConfigStore: emptyStore }),
    credentialVault: unavailableVault(),
  });
  assertSecretMatches(
    "legacy environment provider config",
    environmentRuntime.router.providerConfig(undefined).config.apiKey,
    environmentSecret,
  );

  const keychainSecret = syntheticSecret("legacy-keychain");
  const keychainStore = new UserConfigStore({ picoHome: join(picoHome, "keychain") });
  await keychainStore.write(userConfigWithoutKey(), {
    expectedRevision: EMPTY_USER_CONFIG_REVISION,
  });
  const keychainVault = memoryVault();
  await keychainVault.put(
    credentialRefForProvider({
      providerId: PROVIDER_ID,
      protocol: "openai",
      baseURL: "https://example.test/v1",
    }),
    keychainSecret,
  );
  const keychainRuntime = await loadEffectiveModelRuntime({
    workDir: workspace,
    projectTrusted: false,
    legacyProvider: "openai",
    legacyModel: "unused-legacy-model",
    legacyModelExplicit: false,
    env: {},
    userConfigStore: keychainStore,
    configResolver: new EffectiveConfigResolver({ userConfigStore: keychainStore }),
    credentialVault: keychainVault,
  });
  assertSecretMatches(
    "legacy Keychain provider config",
    keychainRuntime.router.providerConfig(`${PROVIDER_ID}/${MODEL_ID}`).config.apiKey,
    keychainSecret,
  );
});

test("structured logger redacts API-key fields before serialization", async () => {
  const secret = syntheticSecret("structured-log");
  const apiKeyEnv = "PICO_VISIBLE_API_KEY_ENV_METADATA";
  const script = [
    'import { logger } from "./src/observability/logger.ts";',
    "const secret = process.env.PICO_SYNTHETIC_LOG_SECRET;",
    "const apiKeyEnv = process.env.PICO_VISIBLE_API_KEY_ENV_METADATA;",
    'logger.info({ apiKey: secret, apiKeyEnv, config: { providers: { fixture: { apiKey: secret, apiKeyEnv } } }, providers: { fixture: { apiKey: secret, apiKeyEnv } }, req: { body: { config: { providers: { fixture: { apiKey: secret, apiKeyEnv } } } } }, res: { body: { providers: { fixture: { apiKey: secret, apiKeyEnv } } } }, error: { data: { apiKey: secret, providers: { fixture: { apiKey: secret, apiKeyEnv } } } }, err: { data: { config: { providers: { fixture: { apiKey: secret, apiKeyEnv } } } } }, data: { apiKey: secret, config: { providers: { fixture: { apiKey: secret, apiKeyEnv } } } } }, "credential fixture");',
    "logger.flush();",
  ].join("\n");
  const output = await runChildLogger(script, secret, apiKeyEnv);
  assert.equal(output.includes(secret), false, "structured logs must redact plaintext credentials");
  assert.equal(
    output.includes(apiKeyEnv),
    true,
    "apiKeyEnv diagnostic metadata must remain visible",
  );
});

async function createDesktopFixture(suffix: string): Promise<{
  readonly desktop: DesktopRuntimeService;
  readonly userConfig: UserConfigStore;
  readonly vaultCalls: () => number;
  readonly dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pico-config-key-${suffix}-`));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  await registrationStore.register(workspace);
  const env = { PICO_HOME: picoHome };
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const userConfig = new UserConfigStore({ picoHome });
  let calls = 0;
  const unavailable = unavailableVault(() => calls++);
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    registrationStore,
    userConfigStore: userConfig,
    credentialVault: unavailable,
    env,
  });
  return {
    desktop,
    userConfig,
    vaultCalls: () => calls,
    dispose: async () => {
      await desktop.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function providerInput() {
  return { id: PROVIDER_ID, ...providerConfig() };
}

function providerConfig() {
  return {
    protocol: "openai" as const,
    baseURL: "https://example.test/v1",
    apiKeyEnv: API_KEY_ENV,
    models: [MODEL_ID],
    discoverModels: false,
  };
}

function userConfigWithKey(secret: string): PicoUserConfig {
  return {
    version: 1,
    defaults: { modelRouteId: `${PROVIDER_ID}/${MODEL_ID}` },
    providers: { [PROVIDER_ID]: { ...providerConfig(), apiKey: secret } },
  } as unknown as PicoUserConfig;
}

function userConfigWithoutKey(): PicoUserConfig {
  return {
    version: 1,
    defaults: { modelRouteId: `${PROVIDER_ID}/${MODEL_ID}` },
    providers: { [PROVIDER_ID]: providerConfig() },
  };
}

function unavailableVault(onCall: () => void = () => undefined): CredentialVault {
  const unavailable = async (): Promise<never> => {
    onCall();
    throw new Error("synthetic credential vault is unavailable");
  };
  return {
    capability: () => ({
      available: false,
      backend: "unavailable",
      diagnostic: "synthetic unavailable vault",
      cleanupAvailable: false,
    }),
    put: unavailable,
    resolve: unavailable,
    has: unavailable,
    delete: unavailable,
  };
}

function memoryVault(): CredentialVault {
  const secrets = new Map<CredentialRef, string>();
  return {
    capability: () => ({
      available: true,
      backend: "macos-keychain",
      diagnostic: "synthetic in-memory compatibility vault",
    }),
    async put(ref, secret) {
      secrets.set(ref, secret);
    },
    async resolve(ref) {
      const secret = secrets.get(ref);
      if (!secret) throw new CredentialNotFoundError(ref);
      return secret;
    },
    async has(ref) {
      return secrets.has(ref);
    },
    async delete(ref) {
      if (!secrets.delete(ref)) throw new CredentialNotFoundError(ref);
    },
  };
}

function syntheticSecret(suffix: string): string {
  return `pico-synthetic-${suffix}-key-not-a-real-credential`;
}

function readPersistedApiKey(raw: string): unknown {
  return asRecord(asRecord(asRecord(JSON.parse(raw))["providers"])[PROVIDER_ID])["apiKey"];
}

function assertSecretAbsent(label: string, value: unknown, secret: string): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(serialized.includes(secret), false, `${label} exposed a plaintext credential`);
}

function assertSecretMatches(label: string, value: unknown, secret: string): void {
  assert.equal(value === secret, true, `${label} did not receive the synthetic credential`);
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return { name: error.name, message: error.message, stack: error.stack };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0, `${label} must be non-empty`);
  return value;
}

async function readPublicUserRevision(desktop: DesktopRuntimeService): Promise<string> {
  const result = asRecord(await desktop.handle(createRuntimeRequest("provider.list", {})));
  return requiredString(result["revision"], "public user config revision");
}

async function runChildLogger(script: string, secret: string, apiKeyEnv: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "test",
          LOG_LEVEL: "info",
          PICO_SYNTHETIC_LOG_SECRET: secret,
          PICO_VISIBLE_API_KEY_ENV_METADATA: apiKeyEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`structured logger child exited with code ${String(code)}`));
    });
  });
}
