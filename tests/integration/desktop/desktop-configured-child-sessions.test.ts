import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopRuntimeService, WorkspaceRuntimeService } from "../../../src/daemon/index.js";
import { createRuntimeRequest, parseRuntimeResult } from "../../../packages/protocol/src/index.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import type { RuntimeEventBase } from "../../../src/engine/session-runtime-event.js";
import { AgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { currentRuntimeRun } from "../../../src/runtime/runtime-run.js";
import { ModelRouter } from "../../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";
import {
  parseSessionDetail,
  parseSessions,
} from "../../../apps/desktop/src/renderer/runtime-projections/workspace.js";
import { subagentParent } from "../../../apps/desktop/src/renderer/conversation/subagent-navigation.js";
import { workspaceSessionKey } from "../../../apps/desktop/src/renderer/workspace-session.js";
import { SESSION_RUNTIME_STATE_VERSION } from "../../../src/engine/session-runtime.js";
import type { RuntimeOwnerFence } from "../../../src/storage/runtime-event-store-contracts.js";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

function base(sessionId: string, suffix: string): RuntimeEventBase {
  return {
    schemaVersion: 2,
    eventId: `${sessionId}-${suffix}`,
    sessionId,
    invocationId: `${sessionId}-run`,
    runId: `${sessionId}-run`,
    turnId: `${sessionId}-turn`,
    at: "2026-09-09T00:00:00.000Z",
    partial: false,
    visibility: "transcript",
  };
}

test("session list hides admitted children across workspaces and outcomes while detail retains parent navigation", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-child-list-")));
  const picoHome = join(root, "home");
  const parentPath = join(root, "parent");
  const childPath = join(root, "worktree");
  await mkdir(parentPath);
  await mkdir(childPath);
  const runtime = new WorkspaceRuntimeService({
    execute: async () => ({ ok: true }),
    env: { PICO_HOME: picoHome },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: picoHome },
  });
  const stores = [parentPath, childPath].map(
    (path) =>
      new SqliteRuntimeEventStore({
        storageRoot: resolvePicoPaths(path, { picoHome }).workspace.root,
      }),
  );
  const parent = stores[0]!;
  const isolated = stores[1]!;
  const ownerFences = new Map<string, RuntimeOwnerFence>();
  t.after(async () => {
    for (const store of stores) store.close();
    await desktop.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = async (workspacePath: string, sessionId: string) => {
    const store = workspacePath === parentPath ? parent : isolated;
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: workspacePath,
    });
    ownerFences.set(`${workspacePath}\0${sessionId}`, ownerFence);
    await store.append(
      {
        ...base(sessionId, "settings"),
        visibility: "internal",
        kind: "session.state.committed",
        data: {
          stateVersion: SESSION_RUNTIME_STATE_VERSION,
          patch: {
            settings: {
              provider: "openai",
              model: "test",
              modelRouteId: "test/test",
              collaborationMode: "agent",
              permissionMode: "ask",
              thinkingEffort: "off",
              thinkingEffortExplicit: false,
              additionalDirectories: [],
            },
          },
        },
      },
      { ownerFence },
    );
  };
  await create(parentPath, "parent");
  await parent.append(
    {
      ...base("parent", "start"),
      kind: "run.started",
      data: { workDir: parentPath, agentSwarmAuthorization: "none" },
    },
    { ownerFence: ownerFences.get(`${parentPath}\0parent`)! },
  );
  for (const [id, workDir, status] of [
    ["shared", parentPath, "completed"],
    ["isolated", childPath, "completed"],
    ["cancelled", childPath, "cancelled"],
  ] as const) {
    await create(workDir, id);
    const store = workDir === parentPath ? parent : isolated;
    const ownerFence = ownerFences.get(`${workDir}\0${id}`)!;
    await store.append(
      {
        ...base(id, "start"),
        kind: "run.started",
        data: { workDir, agentSwarmAuthorization: "none" },
      },
      { ownerFence },
    );
    await store.append(
      {
        ...base(id, "admit"),
        kind: "message.committed",
        data: {
          message: {
            role: "assistant",
            content: "child admission",
            providerData: {
              picoHiddenFromTranscript: true,
              picoConfiguredChild: {
                version: 1,
                parentSessionId: "parent",
                parentWorkspacePath: parentPath,
                parentRunId: "parent-run",
                parentToolCallId: "spawn",
                childSessionId: id,
                workDir,
                agentName: "Reader",
                status: "started",
                runId: `${id}-run`,
                turnId: `${id}-turn`,
              },
            },
          },
        },
      },
      { ownerFence },
    );
    // Growing history does not move the initial identity out of its bounded prefix.
    if (id === "shared")
      for (let i = 0; i < 110; i++)
        await store.append(
          {
            ...base(id, `output-${i}`),
            kind: "message.committed",
            data: { message: { role: "assistant", content: "continued" } },
          },
          { ownerFence },
        );
    await store.append(
      { ...base(id, "terminal"), kind: "run.terminal", data: { status } },
      { ownerFence },
    );
    const detail = parseRuntimeResult(
      "session.get",
      await desktop.handle(
        createRuntimeRequest("session.get", { workspacePath: workDir, sessionId: id }),
      ),
    );
    assert.deepEqual(detail.session.parentSession, {
      sessionId: "parent",
      workspacePath: parentPath,
      agentName: "Reader",
    });
  }
  await create(childPath, "missing-parent-path");
  const malformedFence = ownerFences.get(`${childPath}\0missing-parent-path`)!;
  await isolated.append(
    {
      ...base("missing-parent-path", "start"),
      kind: "run.started",
      data: { workDir: childPath, agentSwarmAuthorization: "none" },
    },
    { ownerFence: malformedFence },
  );
  await isolated.append(
    {
      ...base("missing-parent-path", "admit"),
      kind: "message.committed",
      data: {
        message: {
          role: "assistant",
          content: "malformed child admission",
          providerData: {
            picoHiddenFromTranscript: true,
            picoConfiguredChild: {
              version: 1,
              parentSessionId: "parent",
              parentRunId: "parent-run",
              parentToolCallId: "spawn",
              childSessionId: "missing-parent-path",
              workDir: childPath,
              agentName: "Reader",
              status: "started",
              runId: "missing-parent-path-run",
              turnId: "missing-parent-path-turn",
            },
          },
        },
      },
    },
    { ownerFence: malformedFence },
  );
  const malformed = parseRuntimeResult(
    "session.get",
    await desktop.handle(
      createRuntimeRequest("session.get", {
        workspacePath: childPath,
        sessionId: "missing-parent-path",
      }),
    ),
  );
  assert.equal(malformed.session.parentSession, undefined);
  // Forks can inherit admission text, but its child ID is still the source ID.
  await create(parentPath, "fork");
  const copied = (
    await parent.readSessionEventsByKind("shared", "message.committed", { limit: 1 })
  )[0]!.event;
  assert.equal(copied.kind, "message.committed");
  if (copied.kind !== "message.committed") throw new Error("Expected admission");
  await parent.append(
    { ...copied, ...base("fork", "copied") },
    { ownerFence: ownerFences.get(`${parentPath}\0fork`)! },
  );
  await create(parentPath, "subagent-user-selected-id");
  for (const includeArchived of [false, true]) {
    const list = parseRuntimeResult(
      "session.list",
      await desktop.handle(
        createRuntimeRequest("session.list", { workspacePath: parentPath, includeArchived }),
      ),
    );
    assert.deepEqual(list.sessions.map((session) => session.sessionId).sort(), [
      "fork",
      "parent",
      "subagent-user-selected-id",
    ]);
    const childList = parseRuntimeResult(
      "session.list",
      await desktop.handle(
        createRuntimeRequest("session.list", { workspacePath: childPath, includeArchived }),
      ),
    );
    assert.deepEqual(
      childList.sessions.map((session) => session.sessionId),
      ["missing-parent-path"],
    );
  }
  await parent.deleteSession("parent");
  const orphan = parseRuntimeResult(
    "session.get",
    await desktop.handle(
      createRuntimeRequest("session.get", { workspacePath: parentPath, sessionId: "shared" }),
    ),
  );
  assert.deepEqual(orphan.session.parentSession, {
    sessionId: "parent",
    workspacePath: parentPath,
    agentName: "Reader",
  });
  const remaining = parseRuntimeResult(
    "session.list",
    await desktop.handle(createRuntimeRequest("session.list", { workspacePath: parentPath })),
  );
  assert.ok(!remaining.sessions.some((session) => session.sessionId === "shared"));
});

test("real configured executor persists its child admission before model output and desktop hides that session", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-child-admission-")));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  const runtime = new WorkspaceRuntimeService({
    execute: async () => ({ ok: true }),
    env: { PICO_HOME: picoHome },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env: { PICO_HOME: picoHome },
  });
  t.after(async () => {
    await desktop.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  const route = {
    id: "fixture/glm-5.2",
    providerId: "fixture",
    provider: "openai" as const,
    model: "glm-5.2",
    baseURL: "https://unused.example/v1",
    apiKeyEnv: "UNUSED",
    auth: "none" as const,
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", "glm-5.2", undefined),
  };
  const router = new ModelRouter([route], {}, route.id);
  let parentCalls = 0;
  let childId = "";
  const result = await new AgentRuntime().execute(
    {
      prompt: "Delegate reading",
      dir: workDir,
      modelRouteId: route.id,
      provider: "openai",
      model: route.model,
      auth: "none",
      baseURL: route.baseURL,
      collaborationMode: "agent",
      permissionMode: "ask",
    },
    {
      picoHome,
      modelRouter: router,
      hostKind: "desktop",
      maxTurns: 3,
      configuredSubagentCatalog: {
        async list() {
          return [
            {
              id: "reader",
              name: "Reader",
              description: "Read",
              profile: "local_read",
              connectionSlug: "fixture",
              model: route.model,
              enabled: true,
              availability: { status: "available" },
            },
          ];
        },
        async resolve() {
          return {
            id: "reader",
            name: "Reader",
            description: "Read",
            profile: "local_read",
            connectionSlug: "fixture",
            model: route.model,
            enabled: true,
            modelRouteId: route.id,
          };
        },
      },
      providerFactory: () => ({
        async generate(_messages, tools) {
          if (tools?.some((tool) => tool.name === "agent_spawn")) {
            if (++parentCalls === 1)
              return {
                role: "assistant" as const,
                content: "",
                toolCalls: [
                  {
                    id: "spawn",
                    name: "agent_spawn",
                    arguments: JSON.stringify({ subagent_id: "reader", task: "Inspect workspace" }),
                  },
                ],
              };
            return { role: "assistant" as const, content: "Done" };
          }
          childId = currentRuntimeRun()!.sessionId;
          return { role: "assistant" as const, content: "Read complete" };
        },
      }),
    },
  );
  assert.ok(childId);
  const list = parseRuntimeResult(
    "session.list",
    await desktop.handle(createRuntimeRequest("session.list", { workspacePath: workDir })),
  );
  assert.deepEqual(
    list.sessions.map((session) => session.sessionId),
    [result.sessionId],
  );
  const detail = parseRuntimeResult(
    "session.get",
    await desktop.handle(
      createRuntimeRequest("session.get", { workspacePath: workDir, sessionId: childId }),
    ),
  );
  assert.deepEqual(detail.session.parentSession, {
    sessionId: result.sessionId,
    workspacePath: workDir,
    agentName: "Reader",
  });
  const child = { sessionId: childId, workspacePath: workDir };
  const session = parseSessionDetail(detail, workDir)!;
  assert.deepEqual(
    subagentParent("", child, {
      [workspaceSessionKey(child)]: { ...child, session, items: [], queuedCount: 0 },
    }),
    { sessionId: result.sessionId, workspacePath: workDir, name: "Reader" },
  );
  assert.deepEqual(
    parseSessions(list, workDir).map((item) => item.id),
    [result.sessionId],
  );
});
