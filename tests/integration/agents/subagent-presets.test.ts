import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  parseRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeSubagentConnection,
  type RuntimeSubagentPreset,
} from "@pico/protocol";
import { createConfiguredSubagentCatalog } from "../../../src/agents/configured-subagent-catalog.js";
import { DesktopSubagentSettingsService } from "../../../src/daemon/desktop-subagent-settings-service.js";
import { UserConfigStore } from "../../../src/input/user-config-store.js";

const preset: RuntimeSubagentPreset = {
  id: "Review",
  name: " Review files ",
  description: " Inspect local files ",
  profile: "local_read",
  connectionSlug: " provider ",
  model: " model ",
  enabled: true,
};
const connection: RuntimeSubagentConnection = {
  id: "provider",
  name: "Provider",
  enabled: true,
  models: [{ id: "model", thinkingLevels: ["low", "high"], offerable: true }],
};
const provider = {
  protocol: "openai" as const,
  baseURL: "https://example.test/v1",
  apiKeyEnv: "TEST_API_KEY",
  apiKey: "not-for-renderer",
  models: ["model"],
  discoverModels: false,
};

test("subagent settings persist normalized presets, preserve Provider secrets, and refresh catalog admission", async (t) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-subagents-"));
  t.after(() => rm(picoHome, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome });
  const initial = await store.read();
  await store.write(
    { version: 1, providers: { provider }, defaults: { thinkingEffort: "high" } },
    { expectedRevision: initial.revision },
  );
  let connections: readonly RuntimeSubagentConnection[] = [
    { ...connection, apiKey: "dependency-secret" },
  ];
  const updates: string[] = [];
  const service = new DesktopSubagentSettingsService({
    userConfigStore: store,
    revisionTokenKey: Buffer.alloc(32, 7),
    getConnections: async () => connections,
    onUpdated: async (revision) => {
      updates.push(revision);
    },
  });
  const empty = await service.get();
  assert.deepEqual(empty.presets, []);
  assert.notEqual(empty.revision, (await store.read()).revision);
  const saved = await service.update({
    expectedRevision: empty.revision,
    presets: [
      preset,
      { ...preset, name: "Duplicate" },
      { ...preset, id: "review", thinkingLevel: "low" },
    ],
  });
  parseRuntimeResult("subagents.update", saved);
  assert.equal(saved.presets.length, 2);
  assert.equal(saved.presets[0]?.name, "Review files");
  assert.equal(saved.presets[0]?.description, "Inspect local files");
  assert.equal(saved.presets[0]?.availability.status, "available");
  assert.equal(saved.presets[0]?.thinkingLevel, undefined);
  assert.deepEqual(updates, [saved.revision]);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.equal((await store.read()).config.providers["provider"]?.apiKey, provider.apiKey);
  assert.equal((await store.read()).config.defaults?.thinkingEffort, "high");
  assert.equal(JSON.parse(await readFile(store.filePath, "utf8")).subagents.presets.length, 2);

  const catalog = createConfiguredSubagentCatalog({
    getPresets: async () => (await store.read()).config.subagents?.presets ?? [],
    getConnections: async () => connections,
  });
  const resolved = await catalog.resolve("Review");
  assert.equal(resolved.modelRouteId, "provider/model");
  assert.equal(resolved.thinkingLevel, undefined);
  const variants: readonly [readonly RuntimeSubagentConnection[], string][] = [
    [[], "missing_connection"],
    [[{ ...connection, retired: true, enabled: false }], "provider_retired"],
    [[{ ...connection, enabled: false }], "connection_disabled"],
    [[{ ...connection, models: [] }], "model_disabled"],
  ];
  for (const [next, reason] of variants) {
    connections = next;
    assert.deepEqual((await catalog.list())[0]?.availability, { status: "unavailable", reason });
    await assert.rejects(catalog.resolve("Review"), new RegExp(reason));
  }
  connections = [{ ...connection, models: [{ ...connection.models[0]!, offerable: false }] }];
  assert.equal((await catalog.resolve("Review")).id, "Review");
  const disabled = await service.update({
    expectedRevision: saved.revision,
    presets: [{ ...preset, enabled: false }],
  });
  assert.deepEqual(disabled.presets[0]?.availability, {
    status: "unavailable",
    reason: "disabled",
  });
  await assert.rejects(catalog.resolve("Review"), /disabled/);
  const deleted = await service.update({ expectedRevision: disabled.revision, presets: [] });
  assert.deepEqual(deleted.presets, []);
  await assert.rejects(catalog.resolve("Review"), /Unknown subagent_id/);
});

test("subagent file normalization matches Maka limits and exact ID deduplication", async (t) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-subagent-normalize-"));
  t.after(() => rm(picoHome, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome });
  await store.read();
  const malformed = [
    null,
    [],
    { ...preset, id: " padded " },
    { ...preset, id: "x".repeat(129) },
    { ...preset, name: "x".repeat(129) },
    { ...preset, thinkingLevel: "unknown" },
    { ...preset, model: "x".repeat(513) },
    { ...preset, connectionSlug: "x".repeat(129) },
    { ...preset, profile: "unknown" },
    { ...preset, enabled: "true" },
  ];
  const valid = { ...preset, description: ` ${"x".repeat(1001)} ` };
  await writeFile(
    store.filePath,
    JSON.stringify({
      version: 1,
      providers: {},
      subagents: {
        presets: [
          ...malformed,
          valid,
          { ...preset, name: "duplicate" },
          { ...preset, id: "review", description: null },
          ...Array.from({ length: 70 }, (_, index) => ({ ...preset, id: `agent:${index}` })),
        ],
      },
    }),
  );
  const normalized = (await store.read()).config.subagents?.presets;
  assert.equal(normalized?.length, 64);
  assert.equal(normalized?.[0]?.id, "Review");
  assert.equal(normalized?.[0]?.description.length, 1000);
  assert.equal(normalized?.[1]?.id, "review");
  assert.equal(normalized?.[1]?.description, "");
  assert.equal(normalized?.[63]?.id, "agent:61");
});

test("subagent IPC rejects unsafe shapes and competing full-array saves conflict without overwriting providers", async (t) => {
  const picoHome = await mkdtemp(join(tmpdir(), "pico-subagent-conflict-"));
  t.after(() => rm(picoHome, { recursive: true, force: true }));
  const store = new UserConfigStore({ picoHome });
  const service = new DesktopSubagentSettingsService({
    userConfigStore: store,
    revisionTokenKey: Buffer.alloc(32, 1),
    getConnections: async () => [connection],
  });
  const initial = await service.get();
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("subagents.get"));
  assert.ok(DESKTOP_RUNTIME_METHODS.includes("subagents.update"));
  const input = { kind: "agent", name: "Review", task: "Inspect changes", subagentId: "Review" };
  assert.deepEqual(
    parseStrictRuntimeParams("session.send", {
      workspacePath: "/workspace",
      idempotencyKey: "send-1",
      input,
    }).input,
    input,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("session.send", {
        workspacePath: "/workspace",
        idempotencyKey: "send-2",
        input: { ...input, subagentId: "../unsafe" },
      }),
    RuntimeProtocolError,
  );
  const catalogAgent = {
    name: "Review",
    description: "",
    source: "preset",
    sourcePath: "",
    tools: [],
    subagentId: "Review",
  };
  assert.deepEqual(parseRuntimeResult("catalog.agents", { agents: [catalogAgent] }).agents, [
    catalogAgent,
  ]);
  assert.throws(
    () => parseRuntimeResult("catalog.agents", { agents: [{ ...catalogAgent, subagentId: 42 }] }),
    RuntimeProtocolError,
  );

  for (const params of [
    { presets: [preset], expectedRevision: "bad" },
    { presets: [{ ...preset, apiKey: "secret" }], expectedRevision: initial.revision },
    { presets: [{ ...preset, thinkingLevel: "unknown" }], expectedRevision: initial.revision },
    { presets: [preset], expectedRevision: initial.revision, unsafe: true },
  ])
    assert.throws(() => parseStrictRuntimeParams("subagents.update", params), RuntimeProtocolError);
  assert.throws(
    () =>
      parseRuntimeResult("subagents.get", {
        ...initial,
        connections: [{ ...connection, apiKey: "secret" }],
      }),
    RuntimeProtocolError,
  );
  const outcomes = await Promise.allSettled([
    service.update({ presets: [preset], expectedRevision: initial.revision }),
    service.update({ presets: [{ ...preset, id: "other" }], expectedRevision: initial.revision }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const failure = outcomes.find((result) => result.status === "rejected");
  assert.ok(failure?.status === "rejected" && failure.reason instanceof RuntimeProtocolError);
  assert.equal(failure.reason.code, RUNTIME_ERROR_CODES.CONFLICT);
  const beforeProviderChange = await service.get();
  const current = await store.read();
  await store.write(
    { ...current.config, providers: { provider } },
    { expectedRevision: current.revision },
  );
  await assert.rejects(
    service.update({ presets: [], expectedRevision: beforeProviderChange.revision }),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
  );
  assert.equal((await store.read()).config.providers["provider"]?.apiKey, provider.apiKey);
  assert.equal((await service.get()).presets.length, 1);
});
