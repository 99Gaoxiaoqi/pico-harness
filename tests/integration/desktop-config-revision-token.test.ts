import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { UserConfigStore } from "../../src/input/user-config-store.js";
import type { CredentialVault } from "../../src/provider/credential-vault.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

const PROVIDER_ID = "revision-token-fixture";

test("Desktop projects user-config revisions into process-private tokens", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-revision-token-"));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const env = { PICO_HOME: picoHome };
  let runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const userConfigStore = new UserConfigStore({ picoHome });
  await registrationStore.register(workspace);
  await trustStore.trust(await trustStore.canonicalize(workspace));
  let desktop = createDesktop(runtime, registrationStore, trustStore, userConfigStore, env);
  context.after(async () => {
    await desktop.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const initialRawRevision = (await userConfigStore.read()).revision;
  const initialList = asRecord(
    await desktop.handle(createRuntimeRequest("provider.list", {})),
  );
  const initialToken = requiredSha256(initialList["revision"], "initial public revision");
  assert.notEqual(initialToken, initialRawRevision);

  const projectedUserConfig = asRecord(
    await desktop.handle(createRuntimeRequest("config.user.get", {})),
  );
  assert.equal(projectedUserConfig["revision"], initialToken);
  const effective = asRecord(
    await desktop.handle(createRuntimeRequest("config.effective.get", { workspacePath: workspace })),
  );
  const effectiveRevisions = asRecord(asRecord(effective["config"])["revisions"]);
  assert.equal(effectiveRevisions["user"], initialToken);

  let rawTokenConflict: unknown;
  try {
    await desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput(),
        expectedRevision: initialRawRevision,
      }),
    );
  } catch (error) {
    rawTokenConflict = error;
  }
  assertConflict(rawTokenConflict);

  const notifications: unknown[] = [];
  const unsubscribe = desktop.subscribe((notification) => notifications.push(notification));
  context.after(unsubscribe);
  const upserted = asRecord(
    await desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput(),
        expectedRevision: initialToken,
      }),
    ),
  );
  const providerToken = requiredSha256(upserted["revision"], "provider public revision");
  const providerRawRevision = (await userConfigStore.read()).revision;
  assert.notEqual(providerToken, providerRawRevision);
  assert.notEqual(providerToken, initialToken);

  const updatedConfig = asRecord(
    await desktop.handle(
      createRuntimeRequest("config.user.update", {
        defaults: { mode: "plan" },
        expectedRevision: providerToken,
      }),
    ),
  );
  const configToken = requiredSha256(updatedConfig["revision"], "updated config revision");
  const configRawRevision = (await userConfigStore.read()).revision;
  assert.notEqual(configToken, configRawRevision);
  assert.notEqual(configToken, providerToken);

  const secret = "pico-synthetic-revision-token-key-not-a-real-credential";
  const setResult = asRecord(
    await desktop.handle(
      createRuntimeRequest("provider.credential.set", {
        providerId: PROVIDER_ID,
        secret,
        expectedRevision: configToken,
      }),
    ),
  );
  const credentialToken = requiredSha256(setResult["revision"], "credential public revision");
  const credentialRawRevision = (await userConfigStore.read()).revision;
  assert.notEqual(credentialToken, credentialRawRevision);
  assert.notEqual(credentialToken, providerToken);

  let staleConflict: unknown;
  try {
    await desktop.handle(
      createRuntimeRequest("provider.credential.delete", {
        providerId: PROVIDER_ID,
        expectedRevision: configToken,
      }),
    );
  } catch (error) {
    staleConflict = error;
  }
  assertConflict(staleConflict);
  assert.equal(readPersistedApiKey(await readFile(userConfigStore.filePath, "utf8")), secret);

  const serializedNotifications = JSON.stringify(notifications);
  for (const rawRevision of [
    initialRawRevision,
    providerRawRevision,
    configRawRevision,
    credentialRawRevision,
  ]) {
    assert.equal(serializedNotifications.includes(rawRevision), false);
  }
  assert.equal(serializedNotifications.includes(secret), false);
  assert.equal(serializedNotifications.includes(providerToken), true);
  assert.equal(serializedNotifications.includes(configToken), true);
  assert.equal(serializedNotifications.includes(credentialToken), true);

  await desktop.close();
  runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  desktop = createDesktop(runtime, registrationStore, trustStore, userConfigStore, env);
  const restarted = asRecord(
    await desktop.handle(createRuntimeRequest("provider.list", {})),
  );
  const restartedToken = requiredSha256(restarted["revision"], "restarted public revision");
  assert.notEqual(restartedToken, credentialToken);
  assert.notEqual(restartedToken, credentialRawRevision);

  let restartedConflict: unknown;
  try {
    await desktop.handle(
      createRuntimeRequest("provider.credential.delete", {
        providerId: PROVIDER_ID,
        expectedRevision: credentialToken,
      }),
    );
  } catch (error) {
    restartedConflict = error;
  }
  assertConflict(restartedConflict);
  assert.equal(readPersistedApiKey(await readFile(userConfigStore.filePath, "utf8")), secret);

  const credentialDeleted = asRecord(
    await desktop.handle(
      createRuntimeRequest("provider.credential.delete", {
        providerId: PROVIDER_ID,
        expectedRevision: restartedToken,
      }),
    ),
  );
  const credentialDeletedToken = requiredSha256(
    credentialDeleted["revision"],
    "credential delete revision",
  );
  const credentialDeletedRawRevision = (await userConfigStore.read()).revision;
  assert.notEqual(credentialDeletedToken, credentialDeletedRawRevision);

  const providerDeleted = asRecord(
    await desktop.handle(
      createRuntimeRequest("provider.delete", {
        providerId: PROVIDER_ID,
        expectedRevision: credentialDeletedToken,
      }),
    ),
  );
  const providerDeletedToken = requiredSha256(
    providerDeleted["revision"],
    "provider delete revision",
  );
  assert.notEqual(providerDeletedToken, (await userConfigStore.read()).revision);
});

function createDesktop(
  runtime: WorkspaceRuntimeService,
  registrationStore: WorkspaceRegistrationStore,
  trustStore: WorkspaceTrustStore,
  userConfigStore: UserConfigStore,
  env: Readonly<Record<string, string | undefined>>,
): DesktopRuntimeService {
  return new DesktopRuntimeService({
    runtimeService: runtime,
    registrationStore,
    trustStore,
    userConfigStore,
    credentialVault: unavailableVault(),
    env,
  });
}

function providerInput() {
  return {
    id: PROVIDER_ID,
    protocol: "openai" as const,
    baseURL: "https://example.test/v1",
    apiKeyEnv: "PICO_REVISION_TOKEN_FIXTURE_API_KEY",
    models: ["fixture-model"],
    discoverModels: false,
  };
}

function unavailableVault(): CredentialVault {
  const unavailable = async (): Promise<never> => {
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

function readPersistedApiKey(raw: string): unknown {
  return asRecord(asRecord(asRecord(JSON.parse(raw))["providers"])[PROVIDER_ID])["apiKey"];
}

function assertConflict(error: unknown): void {
  assert.ok(error instanceof RuntimeProtocolError);
  assert.equal(error.code, RUNTIME_ERROR_CODES.CONFLICT);
}

function requiredSha256(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), `${label} must be SHA-256`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
