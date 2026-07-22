import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseUserConfig,
  UserConfigStore,
  type PicoUserConfig,
} from "../../src/input/user-config-store.js";
import {
  credentialRefForProvider,
  parseProviderCredentialRef,
} from "../../src/provider/credential-vault.js";
import {
  ProviderOperationJournal,
  type ProviderOperationRecord,
} from "../../src/provider/provider-operation-journal.js";

test("provider journal redacts unrelated config keys and recovery preserves their latest value", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-provider-journal-api-key-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome: root });
  const initial = await store.read();
  const firstKey = "provider-a-first-secret";
  const secondKey = "provider-a-concurrent-secret";
  const configured = await store.write(userConfig(firstKey, true), {
    expectedRevision: initial.revision,
  });
  const target = userConfig(firstKey, false);
  const journal = new ProviderOperationJournal({ picoHome: root, parseUserConfig });
  const credentialRef = credentialRefForProvider({
    providerId: "provider-b",
    protocol: "openai",
    baseURL: "https://provider-b.invalid/v1",
  });

  const prepared = await journal.prepare({
    kind: "delete",
    previousUserConfig: configured.config,
    targetUserConfig: target,
    credentialRef,
    credentialExistedBefore: true,
    configRevision: configured.revision,
  });
  assert.equal(prepared.previousUserConfig.providers["provider-a"]?.apiKey, undefined);
  assert.equal(prepared.targetUserConfig.providers["provider-a"]?.apiKey, undefined);
  const rawJournal = await readFile(journal.filePath, "utf8");
  assert.equal(rawJournal.includes(firstKey), false);
  assert.equal(rawJournal.includes('"apiKey"'), false);

  await journal.update(prepared.operationId, { phase: "credential-deleted" });
  const concurrent = await store.write(userConfig(secondKey, true), {
    expectedRevision: configured.revision,
  });
  const recovered = await journal.read();
  assert.ok(recovered);
  const reconciled = reconcileProviderOperation(recovered, concurrent.config);
  const committed = await store.write(reconciled, { expectedRevision: concurrent.revision });
  await journal.update(recovered.operationId, {
    phase: "config-committed",
    configRevision: committed.revision,
  });
  const committedJournal = await readFile(journal.filePath, "utf8");
  assert.equal(committedJournal.includes(firstKey), false);
  assert.equal(committedJournal.includes(secondKey), false);
  assert.equal(committedJournal.includes('"apiKey"'), false);
  await journal.clear(recovered.operationId);

  const final = await store.read();
  assert.equal(final.config.providers["provider-a"]?.apiKey, secondKey);
  assert.equal(final.config.providers["provider-b"], undefined);
  assert.equal(await journal.read(), undefined);
});

function userConfig(apiKey: string, includeProviderB: boolean): PicoUserConfig {
  return parseUserConfig(
    {
      version: 1,
      defaults: { modelRouteId: "provider-a/model-a" },
      providers: {
        "provider-a": {
          protocol: "openai",
          baseURL: "https://provider-a.invalid/v1",
          apiKeyEnv: "PROVIDER_A_API_KEY",
          apiKey,
          models: ["model-a"],
          discoverModels: false,
        },
        ...(includeProviderB
          ? {
              "provider-b": {
                protocol: "openai",
                baseURL: "https://provider-b.invalid/v1",
                apiKeyEnv: "PROVIDER_B_API_KEY",
                models: ["model-b"],
                discoverModels: false,
              },
            }
          : {}),
      },
    },
    "test-user-config",
  );
}

/** Mirrors the daemon's provider-local reconcile contract without depending on its private host. */
function reconcileProviderOperation(
  operation: ProviderOperationRecord,
  current: PicoUserConfig,
): PicoUserConfig {
  const providerId = parseProviderCredentialRef(operation.credentialRef).providerId;
  const targetProvider = operation.targetUserConfig.providers[providerId];
  const providers = { ...current.providers };
  if (targetProvider) providers[providerId] = targetProvider;
  else delete providers[providerId];
  return parseUserConfig(
    {
      version: 1,
      ...(current.defaults ? { defaults: current.defaults } : {}),
      providers,
    },
    "test-provider-recovery",
  );
}
