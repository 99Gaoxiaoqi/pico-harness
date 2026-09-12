import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRuntimeRequest, RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";
import { DesktopRuntimeService, WorkspaceRuntimeService } from "../../../src/daemon/index.js";
import { WorkspaceRegistrationStore } from "../../../src/daemon/workspace-registration.js";
import { parseUserConfig, UserConfigStore } from "../../../src/input/user-config-store.js";
import {
  credentialRefForProvider,
  type CredentialVault,
} from "../../../src/provider/credential-vault.js";
import { ProviderOperationJournal } from "../../../src/provider/provider-operation-journal.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";

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
  const initialList = asRecord(await desktop.handle(createRuntimeRequest("provider.list", {})));
  const initialToken = requiredSha256(initialList["revision"], "initial public revision");
  assert.notEqual(initialToken, initialRawRevision);

  const projectedUserConfig = asRecord(
    await desktop.handle(createRuntimeRequest("config.user.get", {})),
  );
  assert.equal(projectedUserConfig["revision"], initialToken);
  const effective = asRecord(
    await desktop.handle(
      createRuntimeRequest("config.effective.get", { workspacePath: workspace }),
    ),
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
        defaults: {
          collaborationMode: "plan",
          orchestrationMode: "graph",
          permissionMode: "full-access",
        },
        expectedRevision: providerToken,
      }),
    ),
  );
  const updatedDefaults = asRecord(asRecord(updatedConfig["config"])["defaults"]);
  assert.deepEqual(updatedDefaults, {
    collaborationMode: "plan",
    orchestrationMode: "graph",
    permissionMode: "full-access",
  });
  assert.equal(Object.hasOwn(updatedDefaults, "mode"), false);
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
  const restarted = asRecord(await desktop.handle(createRuntimeRequest("provider.list", {})));
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

  const unsubscribeExternal = desktop.subscribe((notification) => notifications.push(notification));
  context.after(unsubscribeExternal);
  const beforeExternal = await userConfigStore.read();
  const external = await userConfigStore.write(
    {
      ...beforeExternal.config,
      defaults: { collaborationMode: "agent", permissionMode: "ask" },
    },
    { expectedRevision: beforeExternal.revision },
  );
  const afterExternal = asRecord(await desktop.handle(createRuntimeRequest("config.user.get", {})));
  const externalToken = requiredSha256(
    afterExternal["revision"],
    "external config public revision",
  );
  const hasExternalNotification = () =>
    notifications.some((entry) => {
      const notification = asRecord(entry);
      return (
        notification["topic"] === "config.updated" &&
        asRecord(notification["payload"])["revision"] === externalToken
      );
    });
  for (let attempt = 0; attempt < 80 && !hasExternalNotification(); attempt++) await delay(25);
  assert.ok(
    hasExternalNotification(),
    "the owned file watcher must publish external config updates",
  );
  assert.notEqual(externalToken, external.revision);
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

test(
  "Provider config commits share admission locking with session.send and run.start",
  { timeout: 10_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-provider-admission-"));
    const picoHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const env = { PICO_HOME: picoHome };
    const userConfigStore = new UserConfigStore({ picoHome });
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending: Promise<unknown>[] = [];
    const originalWrite = userConfigStore.write.bind(userConfigStore);
    userConfigStore.write = async (...args) => {
      entered.resolve();
      await release.promise;
      return originalWrite(...args);
    };
    let forwardedRuns = 0;
    const originalHandle = runtime.handle.bind(runtime);
    runtime.handle = async (request) => {
      if (request.method !== "run.start") return originalHandle(request);
      forwardedRuns++;
      assert.ok((await userConfigStore.read()).config.providers[PROVIDER_ID]);
      return { runId: "admitted-after-config" };
    };
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      userConfigStore,
      trustStore,
      env,
      credentialVault: unavailableVault(),
    });
    context.after(async () => {
      release.resolve();
      await Promise.allSettled(pending);
      await desktop.close();
      await rm(root, { recursive: true, force: true });
    });
    const initial = asRecord(await desktop.handle(createRuntimeRequest("provider.list", {})));
    const writing = desktop.handle(
      createRuntimeRequest("provider.upsert", {
        provider: providerInput(),
        expectedRevision: String(initial["revision"]),
      }),
    );
    pending.push(writing);
    await entered.promise;
    let sendSettled = false;
    const sending = desktop
      .handle(
        createRuntimeRequest("session.send", {
          workspacePath: workspace,
          input: { kind: "text", text: "hello" },
          idempotencyKey: "provider-admission-send",
        }),
      )
      .then((result) => {
        sendSettled = true;
        assert.equal(asRecord(result)["disposition"], "started");
      });
    const starting = desktop.handle(
      createRuntimeRequest("run.start", { workspacePath: workspace, prompt: "hello" }),
    );
    pending.push(sending, starting);
    await delay(40);
    assert.equal(
      sendSettled,
      false,
      "session.send must not enter workspace admission during a config write",
    );
    assert.equal(forwardedRuns, 0, "run.start must use the same dependency lock");
    release.resolve();
    await writing;
    await sending;
    assert.deepEqual(await starting, { runId: "admitted-after-config" });
    assert.equal(forwardedRuns, 1, "the direct run.start request is forwarded once");
  },
);

test(
  "Provider journal recovery completes before admission and preserves concurrent configuration",
  { timeout: 10_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-provider-recovery-owner-"));
    const env = { PICO_HOME: root };
    const userConfigStore = new UserConfigStore({ picoHome: root });
    const previous = await userConfigStore.read();
    const { id, ...provider } = providerInput();
    const target = parseUserConfig(
      { version: 1, providers: { [id]: provider } },
      "recovery fixture",
    );
    const journal = new ProviderOperationJournal({ picoHome: root, parseUserConfig });
    const operation = await journal.prepare({
      kind: "import",
      previousUserConfig: previous.config,
      targetUserConfig: target,
      credentialRef: credentialRefForProvider({
        providerId: id,
        protocol: provider.protocol,
        baseURL: provider.baseURL,
      }),
      credentialExistedBefore: false,
      configRevision: previous.revision,
    });
    await journal.update(operation.operationId, { phase: "credential-imported" });
    await userConfigStore.write(
      {
        ...previous.config,
        defaults: { collaborationMode: "plan", permissionMode: "ask" },
      },
      { expectedRevision: previous.revision },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const vault: CredentialVault = {
      ...unavailableVault(),
      capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "fixture" }),
      has: async () => {
        entered.resolve();
        await release.promise;
        return true;
      },
    };
    const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
    let forwarded = false;
    const originalHandle = runtime.handle.bind(runtime);
    runtime.handle = async (request) => {
      if (request.method !== "run.start") return originalHandle(request);
      assert.equal(
        await journal.read(),
        undefined,
        "journal must be cleared after config commit before admission",
      );
      const snapshot = await userConfigStore.read();
      assert.ok(snapshot.config.providers[id]);
      assert.equal(snapshot.config.defaults?.collaborationMode, "plan");
      assert.equal(snapshot.config.defaults?.permissionMode, "ask");
      forwarded = true;
      return { runId: "recovered-admission" };
    };
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      userConfigStore,
      providerOperationJournal: journal,
      credentialVault: vault,
      env,
    });
    const pending: Promise<unknown>[] = [];
    context.after(async () => {
      release.resolve();
      await Promise.allSettled(pending);
      await desktop.close();
      await rm(root, { recursive: true, force: true });
    });
    await entered.promise;
    const starting = desktop.handle(
      createRuntimeRequest("run.start", { workspacePath: root, prompt: "hello" }),
    );
    pending.push(starting);
    await delay(40);
    assert.equal(forwarded, false);
    release.resolve();
    assert.deepEqual(await starting, { runId: "recovered-admission" });

    await desktop.close();
    const recovered = await userConfigStore.read();
    const missingCredential = await journal.prepare({
      kind: "import",
      previousUserConfig: recovered.config,
      targetUserConfig: recovered.config,
      credentialRef: operation.credentialRef,
      credentialExistedBefore: false,
      configRevision: recovered.revision,
    });
    await journal.update(missingCredential.operationId, { phase: "credential-imported" });
    const blockedRuntime = new WorkspaceRuntimeService({
      env,
      execute: async () => assert.fail("failed recovery must never admit a Run"),
    });
    const blockedDesktop = new DesktopRuntimeService({
      runtimeService: blockedRuntime,
      userConfigStore,
      providerOperationJournal: journal,
      credentialVault: { ...vault, has: async () => false },
      env,
    });
    try {
      await assert.rejects(
        blockedDesktop.handle(
          createRuntimeRequest("run.start", { workspacePath: root, prompt: "hello" }),
        ),
        (error: unknown) =>
          error instanceof RuntimeProtocolError &&
          error.code === RUNTIME_ERROR_CODES.CONFLICT &&
          /恢复尚未完成/u.test(error.message),
      );
      assert.equal((await journal.read())?.phase, "credential-imported");
      assert.equal((await userConfigStore.read()).revision, recovered.revision);
    } finally {
      await blockedDesktop.close();
    }
  },
);
