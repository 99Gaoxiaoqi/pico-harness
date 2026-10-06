import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { createRuntimeRequest } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { DesktopProviderConfigService } from "@pico/pico-host/desktop-provider-config-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { UserConfigStore, parseUserConfig } from "@pico/pico-host/input/user-config-store";
import { ProviderOperationJournal } from "@pico/pico-host/provider/provider-operation-journal";
import {
  credentialRefForProvider,
  type CredentialVault,
} from "@pico/pico-host/provider/credential-vault";
import {
  RuntimeHostKernel,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from "@pico/runtime-host";

async function recoveryFixture(context: { after(cleanup: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pico-provider-drain-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  const entered = deferred();
  const release = deferred();
  let lookups = 0;
  const vault: CredentialVault = {
    capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "test" }),
    has: async () => {
      lookups++;
      entered.resolve();
      await release.promise;
      return true;
    },
    put: async () => undefined,
    delete: async () => undefined,
    resolve: async () => "fixture-token",
  };
  const store = new UserConfigStore({ picoHome });
  const initial = await store.read();
  const journal = new ProviderOperationJournal({ picoHome, parseUserConfig });
  const provider = {
    protocol: "openai" as const,
    baseURL: "https://provider.invalid/v1",
    apiKeyEnv: "TOKEN",
    models: ["coder"],
    discoverModels: false,
  };
  await journal.prepare({
    kind: "import",
    previousUserConfig: initial.config,
    targetUserConfig: { version: 1, providers: { test: provider } },
    credentialRef: credentialRefForProvider({ providerId: "test", ...provider }),
    credentialExistedBefore: true,
    configRevision: initial.revision,
  });
  context.after(async () => {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  });
  return { picoHome, entered, release, vault, store, journal, lookups: () => lookups };
}

test("Provider close shares its drain promise and waits for blocked startup vault recovery", async (context) => {
  const fixture = await recoveryFixture(context);
  const service = new DesktopProviderConfigService({
    picoHome: fixture.picoHome,
    env: {},
    revisionTokenKey: createHash("sha256").update("fixture").digest(),
    userConfigStore: fixture.store,
    credentialVault: fixture.vault,
    providerOperationJournal: fixture.journal,
    listWorkspacePaths: async () => [],
    requireTrustedWorkspace: async (path) => path,
    assertNoActiveRuns: async () => undefined,
    providerReferences: () => [],
    publishUserConfigUpdated: async () => undefined,
  });
  await fixture.entered.promise;
  let closed = false;
  const close = service.close().then(() => {
    closed = true;
  });
  assert.equal(service.close(), service.close());
  await assert.rejects(
    service.withProviderDependencyLock(async () => ({ accepted: true })),
    /正在关闭/u,
  );
  await nextTick();
  assert.equal(closed, false);
  fixture.release.resolve();
  await close;
  assert.equal(await fixture.journal.read(), undefined);
  assert.ok((await fixture.store.read()).config.providers.test);
  assert.equal(fixture.lookups(), 1);
});

test("Desktop drains handles accepted before close even while the Provider watch is starting", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-provider-handle-drain-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  const store = new UserConfigStore({ picoHome });
  const entered = deferred();
  const release = deferred();
  const originalRead = store.read.bind(store);
  let reads = 0;
  store.read = async () => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return originalRead();
  };
  const runtime = new WorkspaceRuntimeService({
    env: { PICO_HOME: picoHome },
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: picoHome },
    userConfigStore: store,
  });
  context.after(async () => {
    release.resolve();
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  await entered.promise;
  const accepted = desktop.handle(
    createRuntimeRequest("config.user.update", { defaults: {}, expectedRevision: "0".repeat(64) }),
  );
  const closing = desktop.close();
  release.resolve();
  await assert.rejects(
    accepted,
    /用户配置已更改/u,
    "accepted request must reach CAS rather than encounter Provider close",
  );
  await closing;
});

test("Host shutdown grace keeps ownership while blocked Provider recovery requires termination", async (context) => {
  const fixture = await recoveryFixture(context);
  const runtime = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    execute: async () => undefined,
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: fixture.picoHome },
    userConfigStore: fixture.store,
    credentialVault: fixture.vault,
    providerOperationJournal: fixture.journal,
  });
  const capability = await resolveStorageRoot({ path: fixture.picoHome, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const kernel = await RuntimeHostKernel.start({
    owner,
    shutdownGraceMs: 50,
    compositionFactory: async () => ({
      handlers: {},
      beginDrain: () => desktop.beginDrain(),
      recover: async () => undefined,
      close: () => desktop.close(),
    }),
  });
  context.after(async () => {
    fixture.release.resolve();
    await desktop.close();
    await owner.close();
  });
  await fixture.entered.promise;
  await assert.rejects(
    kernel.close(),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "process_termination_required",
  );
  assert.equal(await tryAcquireInteractiveRootOwner(capability), undefined);
  fixture.release.resolve();
  await desktop.close();
  await nextTick();
  assert.equal(
    await tryAcquireInteractiveRootOwner(capability),
    undefined,
    "late recovery must not release the retained Host owner after termination was requested",
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
