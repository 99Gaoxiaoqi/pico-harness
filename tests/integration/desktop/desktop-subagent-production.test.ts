import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DesktopRuntimeService, WorkspaceRuntimeService } from "../../../src/daemon/index.js";
import {
  createRuntimeRequest,
  parseRuntimeResult,
  parseStrictRuntimeParams,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSubagentPreset,
} from "@pico/protocol";
import { WorkspaceRegistrationStore } from "../../../src/daemon/workspace-registration.js";
import { UserConfigStore } from "../../../src/input/user-config-store.js";
import type { CredentialVault } from "../../../src/provider/credential-vault.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { SqliteDesktopConversationStateStore } from "../../../src/storage/sqlite/sqlite-desktop-conversation-state-store.js";

// The executor seam avoids a model call while exercising production Desktop admission,
// configuration ownership, catalog projection, and the exact frontend protocol contracts.
test(
  "Desktop subagent presets survive Provider edits and admit by stable ID through the production protocol",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-subagents-"));
    const picoHome = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const env = { PICO_HOME: picoHome };
    const userConfigStore = new UserConfigStore({ picoHome });
    const initial = await userConfigStore.read();
    const provider = {
      protocol: "openai" as const,
      baseURL: "http://127.0.0.1:1/v1",
      apiKeyEnv: "PICO_SUBAGENT_FIXTURE_UNUSED_KEY",
      auth: "none" as const,
      models: ["fixture-model"],
      discoverModels: false,
    };
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: "fixture/fixture-model" },
        providers: { fixture: provider },
      },
      { expectedRevision: initial.revision },
    );
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(await trustStore.canonicalize(workspace));
    const registrationStore = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
    await registrationStore.register(workspace);
    const prompts: string[] = [];
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ prompt }) => {
        prompts.push(prompt);
        return { ok: true };
      },
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      registrationStore,
      trustStore,
      userConfigStore,
      credentialVault: unavailableVault(),
      env,
    });
    context.after(async () => {
      await desktop.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });
    async function request<Method extends RuntimeMethod>(
      method: Method,
      params: RuntimeParams<Method>,
    ): Promise<RuntimeResult<Method>> {
      return parseRuntimeResult(
        method,
        await desktop.handle(
          createRuntimeRequest(method, parseStrictRuntimeParams(method, params)),
        ),
      );
    }

    const empty = await request("subagents.get", {});
    assert.deepEqual(empty.presets, []);
    assert.ok(empty.connections.some((connection) => connection.id === "fixture"));
    const preset: RuntimeSubagentPreset = {
      id: "review-stable",
      name: "Review display name",
      description: "Inspect local files",
      profile: "local_read",
      connectionSlug: "fixture",
      model: "fixture-model",
      enabled: true,
    };
    const saved = await request("subagents.update", {
      presets: [preset],
      expectedRevision: empty.revision,
    });
    assert.equal(saved.presets[0]?.availability.status, "available");
    const catalog = await request("catalog.agents", { workspacePath: workspace });
    assert.ok(catalog.agents.some((agent) => agent.subagentId === preset.id));

    const userConfig = await request("config.user.get", {});
    await request("config.user.update", {
      defaults: { modelRouteId: "fixture/fixture-model", thinkingEffort: "high" },
      expectedRevision: userConfig.revision,
    });
    const afterDefaults = await request("subagents.get", {});
    assert.equal(afterDefaults.presets[0]?.id, preset.id);
    assert.equal(afterDefaults.presets[0]?.thinkingLevel, undefined);
    const providerList = await request("provider.list", {});
    await request("provider.upsert", {
      provider: { ...provider, id: "fixture", models: ["fixture-model", "another-model"] },
      expectedRevision: providerList.revision,
    });
    const afterProvider = await request("subagents.get", {});
    assert.equal(afterProvider.presets[0]?.id, preset.id);
    assert.equal(afterProvider.presets[0]?.availability.status, "available");
    assert.ok(afterProvider.connections[0]?.models.some((model) => model.id === "another-model"));
    await assert.rejects(
      request("subagents.update", { presets: [], expectedRevision: afterDefaults.revision }),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
    );
    assert.equal((await request("subagents.get", {})).presets[0]?.id, preset.id);

    const queue = new SqliteDesktopConversationStateStore({ picoHome });
    const queued = await queue.enqueue(workspace, "queued-preset-session", {
      kind: "agent",
      name: "A stale queued display label",
      subagentId: preset.id,
      task: "Resume using the saved identity",
    });
    const reopenedQueue = new SqliteDesktopConversationStateStore({ picoHome });
    assert.deepEqual(
      (await reopenedQueue.listQueued(workspace, "queued-preset-session"))[0]?.input,
      queued.input,
      "SQLite queue reopening must preserve the preset identity",
    );
    await reopenedQueue.removeQueued(workspace, queued.queueId);

    const sent = await request("session.send", {
      workspacePath: workspace,
      input: {
        kind: "agent",
        name: "A stale display label, never an ID",
        subagentId: preset.id,
        task: "Inspect the fixture files",
      },
      idempotencyKey: "preset-first-send",
    });
    assert.equal(sent.disposition, "started");
    const sessionId = sent.session.sessionId;
    const deadline = Date.now() + 5_000;
    let finished = false;
    while (Date.now() < deadline) {
      const runs = await request("runs.list", { workspacePath: workspace, sessionId });
      if (runs.runs.some((run) => run.status === "succeeded")) {
        finished = true;
        break;
      }
      await delay(10);
    }
    assert.ok(finished, "the production-admitted run should finish through the executor seam");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /agent_spawn/u);
    assert.match(prompts[0]!, /"subagent_id"\s*:\s*"review-stable"/u);
    assert.match(prompts[0]!, /Inspect the fixture files/u);
    assert.doesNotMatch(prompts[0]!, /"subagent_id"\s*:\s*"A stale display label/u);

    const beforeDisable = await request("subagents.get", {});
    const disabled = await request("subagents.update", {
      presets: [{ ...preset, enabled: false }],
      expectedRevision: beforeDisable.revision,
    });
    assert.deepEqual(disabled.presets[0]?.availability, {
      status: "unavailable",
      reason: "disabled",
    });
    await assert.rejects(
      request("session.send", {
        workspacePath: workspace,
        sessionId,
        input: {
          kind: "agent",
          name: preset.name,
          subagentId: preset.id,
          task: "Must not execute",
        },
        idempotencyKey: "disabled-preset-send",
      }),
      /disabled|unavailable|不可用|停用|禁用/u,
    );
    assert.equal(prompts.length, 1, "disabled presets must fail before executor admission");
    const beforeDeletion = await request("session.get", { workspacePath: workspace, sessionId });
    const deleted = await request("subagents.update", {
      presets: [],
      expectedRevision: disabled.revision,
    });
    assert.deepEqual(deleted.presets, []);
    assert.equal(
      (await request("catalog.agents", { workspacePath: workspace })).agents.some(
        (agent) => agent.subagentId === preset.id,
      ),
      false,
    );
    assert.deepEqual(
      await request("session.get", { workspacePath: workspace, sessionId }),
      beforeDeletion,
    );
    assert.equal((await userConfigStore.read()).config.providers["fixture"]?.models.length, 2);
  },
);

function unavailableVault(): CredentialVault {
  const unavailable = async (): Promise<never> => {
    throw new Error("fixture must not access credentials");
  };
  return {
    capability: () => ({
      available: false,
      backend: "unavailable",
      diagnostic: "auth:none fixture",
      cleanupAvailable: false,
    }),
    put: unavailable,
    resolve: unavailable,
    has: unavailable,
    delete: unavailable,
  };
}
