import { ingestDesktopRuntimeNotification } from "../../../src/daemon/desktop-transcript-persistence.js";
import { createRuntimeNotification } from "../../../packages/protocol/src/index.js";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import {
  subagentParent,
  subagentSessionHref,
} from "../../../apps/desktop/src/renderer/conversation/subagent-navigation.js";
import type { Reporter, SubagentActivityEvent } from "../../../src/engine/reporter.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../../src/agent-graph/sqlite-control-store-adapter.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorktreeSupervisor } from "../../../src/tasks/worktree-supervisor.js";
import { TaskRegistry } from "../../../src/tasks/task-registry.js";
import { createAgentGraphApplicationService } from "../../../src/agent-graph/service.js";
import { SqliteAgentGraphControlStore } from "../../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeConfiguredSubagent } from "@pico/protocol";
import {
  ConfiguredAgentListTool,
  ConfiguredAgentSpawnTool,
} from "../../../src/tools/configured-subagent-tools.js";
import {
  requireSubagentCapability,
  type ConfiguredSubagentCatalogPort,
} from "../../../src/agents/subagent-profiles.js";
import {
  createConfiguredAgentGraphOperatorProfileCatalog,
  createCatalogAgentGraphOperatorProfileCatalog,
  assertValidAgentGraphOperatorProfileSnapshot,
} from "../../../src/agent-graph/operator-profile-catalog.js";
import {
  configuredSubagentExecutionBoundary,
  createConfiguredSubagentExecutor,
} from "../../../src/runtime/configured-subagent-executor.js";
import { AgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { ModelRouter } from "../../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";
import { currentRuntimeRun } from "../../../src/runtime/runtime-run.js";
import { Session, globalSessionManager } from "../../../src/engine/session.js";
import {
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
  createReadOnlyPermissionProfile,
} from "../../../src/safety/permission-profile.js";

function fixture() {
  let presets: RuntimeConfiguredSubagent[] = Array.from(
    { length: 10 },
    (_, i): RuntimeConfiguredSubagent => ({
      id: `reader-${i}`,
      name: `Reader ${i}`,
      description: "Inspect one file",
      profile: "local_read",
      connectionSlug: "test",
      model: "glm-5.2",
      enabled: i !== 9,
      availability:
        i === 9 ? { status: "unavailable", reason: "disabled" } : { status: "available" },
    }),
  );
  const catalog: ConfiguredSubagentCatalogPort = {
    async list() {
      return structuredClone(presets);
    },
    async resolve(id) {
      const entry = presets.find((preset) => preset.id === id);
      if (!entry || entry.availability.status !== "available")
        throw new Error("Preset unavailable");
      const { availability: _, ...preset } = entry;
      return { ...preset, modelRouteId: "test/glm-5.2" };
    },
  };
  return {
    catalog,
    set: (next: RuntimeConfiguredSubagent[]) => {
      presets = next;
    },
  };
}

test("one live preset catalog drives paginated discovery, foreground admission and frozen Graph snapshots", async () => {
  const f = fixture();
  const list = new ConfiguredAgentListTool({ catalog: f.catalog });
  const first = JSON.parse(await list.execute("{}"));
  assert.equal(first.presets.length, 8);
  assert.equal(first.page.next_cursor, "8");
  assert.equal(first.page.total, 9);
  assert.equal(first.legacy_profiles.length, 3);
  assert.equal(JSON.parse(await list.execute('{"cursor":"8"}')).presets[0].subagent_id, "reader-8");
  assert.equal(
    JSON.parse(await list.execute('{"view":"catalog","cursor":"8"}')).presets[1].reason,
    "disabled",
  );
  const graph = createConfiguredAgentGraphOperatorProfileCatalog(f.catalog);
  const snapshot = await graph.resolveForExecution!({
    profileId: "reader-0",
    rootModelRouteId: "parent/other",
    requireConfiguredPreset: true,
  });
  assert.equal(snapshot.modelRouteId, "test/glm-5.2");
  assert.equal(snapshot.thinkingEffort, undefined);
  assert.deepEqual(snapshot.tools, ["read_file", "glob", "grep"]);
  assertValidAgentGraphOperatorProfileSnapshot(snapshot);
  let runs = 0;
  const spawn = new ConfiguredAgentSpawnTool({
    catalog: f.catalog,
    execute: async (input) => {
      runs++;
      assert.equal(input.definition.profile, "local_read");
      assert.equal(input.preset?.id, "reader-0");
      return {
        status: "completed",
        sessionId: "child",
        ref: "pico://session/child",
        summary: "Done",
      };
    },
  });
  assert.equal(
    JSON.parse(
      await spawn.execute(
        '{"subagent_id":"reader-0","profile":"invalid-ignored","task":"Read a file"}',
      ),
    ).sessionId,
    "child",
  );
  await assert.rejects(
    spawn.execute('{"subagent_id":"reader-0","task":"Read","write_back":"patch"}'),
    /write_back/,
  );
  f.set([]);
  await assert.rejects(
    spawn.execute('{"subagent_id":"reader-0","profile":"local_read","task":"Read"}'),
    /unavailable/,
  );
  await assert.rejects(
    graph.resolveForExecution!({
      profileId: "implementation",
      rootModelRouteId: "root",
      requireConfiguredPreset: true,
    }),
    /unavailable/,
  );
  assert.equal(runs, 1);
  assert.equal(snapshot.subagentPreset?.name, "Reader 0");
  assertValidAgentGraphOperatorProfileSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const legacy = createCatalogAgentGraphOperatorProfileCatalog([
    {
      name: "implementation",
      description: "Original readonly profile",
      systemPrompt: "Inspect",
      tools: ["read_file"],
      source: "project-native",
      sourcePath: "/fixture/agents.yaml",
    },
  ]);
  const collision = createConfiguredAgentGraphOperatorProfileCatalog(f.catalog, legacy);
  assert.deepEqual(
    (
      await collision.resolveForExecution!({
        profileId: "implementation",
        rootModelRouteId: "root",
        requireConfiguredPreset: false,
      })
    ).tools,
    ["read_file"],
  );
  assert.ok(
    (
      await collision.resolveForExecution!({
        profileId: "implementation",
        rootModelRouteId: "root",
        requireConfiguredPreset: false,
        legacyCapabilityId: true,
      })
    ).tools.includes("write_file"),
  );
});

test("foreground agent_spawn uses a separate durable RuntimeRun and exact local capability without inheriting parent thinking", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-configured-subagent-")));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await writeFile(join(workDir, "evidence.txt"), "CHILD_EVIDENCE_73");
  const f = fixture();
  const route = {
    id: "test/glm-5.2",
    providerId: "test",
    provider: "openai" as const,
    model: "glm-5.2",
    baseURL: "https://unused.example/v1",
    apiKeyEnv: "UNUSED",
    auth: "none" as const,
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", "glm-5.2", undefined),
  };
  const router = new ModelRouter([route], {}, route.id);
  const childRuns: string[] = [];
  const levels: (string | undefined)[] = [];
  let childSessionId = "";
  let parentCalls = 0;
  const activities: SubagentActivityEvent[] = [];
  const reporter: Reporter = new SilentReporter();
  reporter.onSubagentActivity = (activity) => activities.push(structuredClone(activity));
  try {
    const parentResult = await new AgentRuntime().execute(
      {
        prompt: "Delegate a bounded file read",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: "configured-execution-parent" },
        modelRouteId: route.id,
        provider: "openai",
        model: route.model,
        auth: "none",
        baseURL: route.baseURL,
        thinkingEffort: "nothink",
        collaborationMode: "agent",
        permissionMode: "full-access",
      },
      {
        picoHome,
        modelRouter: router,
        configuredSubagentCatalog: f.catalog,
        reporter,
        hostKind: "desktop",
        maxTurns: 5,
        providerFactory: (_kind, config) => {
          levels.push(config.thinkingEffort);
          let childCalls = 0;
          return {
            async generate(_messages, tools) {
              if (tools?.some((tool) => tool.name === "agent_spawn")) {
                parentCalls++;
                if (parentCalls === 1)
                  return {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: "spawn-reader",
                        name: "agent_spawn",
                        arguments: JSON.stringify({
                          subagent_id: "reader-0",
                          profile: "implementation",
                          task: "Read evidence.txt and report exact value",
                        }),
                      },
                    ],
                  };
                if (parentCalls === 2) {
                  f.set([]);
                  return {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: "read-child-output",
                        name: "agent_output",
                        arguments: JSON.stringify({
                          locator: "child_session_run",
                          child_session_id: childSessionId,
                          run_id: childRuns[0],
                        }),
                      },
                    ],
                  };
                }
                const output = _messages.find(
                  (message) => message.toolCallId === "read-child-output",
                );
                assert.match(output?.content ?? "", /CHILD_EVIDENCE_73/);
                return { role: "assistant" as const, content: "Parent complete" };
              }
              const run = currentRuntimeRun()!;
              childRuns.push(run.runId);
              childSessionId = run.sessionId;
              assert.deepEqual(tools?.map((tool) => tool.name).sort(), [
                "glob",
                "grep",
                "read_file",
              ]);
              childCalls++;
              return childCalls === 1
                ? {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: "read-evidence",
                        name: "read_file",
                        arguments: '{"path":"evidence.txt"}',
                      },
                    ],
                  }
                : {
                    role: "assistant" as const,
                    content: "Found CHILD_EVIDENCE_73 in evidence.txt.",
                  };
            },
          };
        },
      },
    );
    assert.equal(parentCalls, 3);
    assert.ok(childSessionId.startsWith("subagent-"));
    assert.equal(new Set(childRuns).size, 1);
    assert.deepEqual(levels, ["nothink", "max"]);
    const completed = activities.findLast((activity) => activity.status === "completed");
    assert.equal(completed?.childSessionId, childSessionId);
    assert.equal(completed?.childWorkspacePath, workDir);
    assert.ok(completed?.toolCallId);
    assert.ok(typeof completed?.durationMs === "number" && completed.durationMs >= 0);
    assert.ok(
      activities
        .filter((activity) => activity.status === "running")
        .every((activity) => activity.childSessionId === childSessionId),
    );
    await globalSessionManager.clearAndDrain();
    const parent = new Session(parentResult.sessionId, workDir, { persistence: true, picoHome });
    try {
      await parent.recover();
      await ingestDesktopRuntimeNotification(
        parent,
        createRuntimeNotification({
          topic: "run.timeline",
          scope: { sessionId: parent.id, workspacePath: workDir, runId: "presentation-parent-run" },
          at: Date.now(),
          resourceVersion: 1,
          payload: { item: { eventType: "subagent.activity", data: { ...completed! } } },
        }),
      );
      const page = await parent.runtimeEventStore!.readTranscriptProjectionPage({
        sessionId: parent.id,
        maxBytes: 512 * 1024,
      });
      const conversation = parseConversation(
        { items: page.items.map((item) => item.payload) },
        workDir,
        parent.id,
      );
      const childItem = conversation.items.find((item) => item.kind === "subagent");
      assert.ok(childItem?.kind === "subagent");
      assert.equal(childItem.childSessionId, childSessionId);
      assert.equal(childItem.readOnly, true);
      assert.equal(childItem.durationMs, completed?.durationMs);
      assert.equal(childItem.toolCallId, completed?.toolCallId);
      const spawnItem = conversation.items.find(
        (item) => item.kind === "tool" && item.toolName === "agent_spawn",
      );
      assert.ok(spawnItem?.kind === "tool");
      assert.equal(
        childItem.toolCallId,
        spawnItem.result?.toolCallId,
        "the execution row must refer to the exact spawn tool call",
      );
      const href = subagentSessionHref(childItem, { sessionId: parent.id, workspacePath: workDir });
      assert.ok(href);
      const childRef = { sessionId: childSessionId, workspacePath: workDir };
      // A reload has no cached parent conversation; the URL must preserve the parent route.
      assert.equal(
        subagentParent(href.slice(href.indexOf("?")), childRef, {})?.sessionId,
        parent.id,
      );
      // Sidebar entry can recover the same relation from the loaded durable parent.
      assert.equal(subagentParent("", childRef, { parent: conversation })?.sessionId, parent.id);
    } finally {
      await parent.close();
    }
    const child = new Session(childSessionId, workDir, { persistence: true, picoHome });
    try {
      await child.recover();
      const boundary = child.getRuntimeStateSnapshot().boundary;
      assert.equal(boundary?.kind, "bypass");
      const events = await child.runtimeEventStore!.readRun(childSessionId, childRuns[0]!);
      assert.ok(events.some((event) => event.kind === "run.terminal"));
      assert.ok(JSON.stringify(events).includes("CHILD_EVIDENCE_73"));
    } finally {
      await child.close();
    }
    assert.equal(await readFile(join(workDir, "evidence.txt"), "utf8"), "CHILD_EVIDENCE_73");
  } finally {
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});

test("implementation returns a patch including new files while the host checkout is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-preset-patch-"));
  const workDir = join(root, "repo");
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: workDir });
  await mkdir(workDir);
  await git(["init"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["config", "user.name", "Test"]);
  await writeFile(join(workDir, "original.txt"), "before\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  const route = {
    id: "test/model",
    providerId: "test",
    provider: "openai" as const,
    model: "model",
    baseURL: "https://unused.example/v1",
    apiKeyEnv: "UNUSED",
    auth: "none" as const,
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", "model", undefined),
  };
  const supervisor = new WorktreeSupervisor({
    repoRoot: workDir,
    taskRegistry: new TaskRegistry(),
  });
  try {
    const execute = createConfiguredSubagentExecutor({
      workDir,
      modelRouter: new ModelRouter([route], {}, route.id),
      parentModelRouteId: route.id,
      parentExecutionBoundary: () => createBypassExecutionBoundary(),
      worktreeSupervisor: supervisor,
      executeChild: async (options, dependencies) => {
        assert.notEqual(options.dir, workDir);
        assert.equal(options.collaborationMode, "agent");
        assert.equal(options.permissionMode, "full-access");
        assert.deepEqual(options.allowedTools, requireSubagentCapability("implementation").tools);
        const ceiling = dependencies?.configuredSubagentChild?.executionBoundaryCeiling;
        assert.equal(ceiling?.kind, "bypass");
        await writeFile(join(options.dir!, "original.txt"), "after\n");
        await writeFile(join(options.dir!, "new.txt"), "new content\n");
        return {
          sessionId: options.sessionSelection!.sessionId,
          sessionSelection: options.sessionSelection!,
          workDir: options.dir!,
          finalMessage: "Updated original and added new",
          messages: [],
          usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        };
      },
    });
    const result = await execute({
      task: "Edit original and add new",
      definition: requireSubagentCapability("implementation"),
    });
    assert.ok(result.patch);
    const patch = await readFile(result.patch.path, "utf8");
    assert.match(patch, /new file mode/);
    assert.match(patch, /new content/);
    assert.match(patch, /after/);
    assert.equal(await readFile(join(workDir, "original.txt"), "utf8"), "before\n");
    assert.equal((await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim(), "");
    assert.deepEqual(result.artifactIds, [result.patch.path]);
    assert.equal(result.permissionMode, "full-access");
  } finally {
    await supervisor.beginShutdown().released;
    await rm(root, { recursive: true, force: true });
  }
});

test("a managed parent keeps a shared configured child in ask mode under a read-only ceiling", async () => {
  const route = {
    id: "test/model",
    providerId: "test",
    provider: "openai" as const,
    model: "model",
    baseURL: "https://unused.example/v1",
    apiKeyEnv: "UNUSED",
    auth: "none" as const,
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", "model", undefined),
  };
  const execute = createConfiguredSubagentExecutor({
    workDir: process.cwd(),
    modelRouter: new ModelRouter([route], {}, route.id),
    parentModelRouteId: route.id,
    parentExecutionBoundary: () =>
      createManagedExecutionBoundary(createReadOnlyPermissionProfile()),
    executeChild: async (options, dependencies) => {
      assert.equal(options.collaborationMode, "agent");
      assert.equal(options.permissionMode, "ask");
      const ceiling = dependencies?.configuredSubagentChild?.executionBoundaryCeiling;
      assert.ok(ceiling?.kind === "managed");
      assert.equal(ceiling.profile.name, "read-only");
      assert.equal(ceiling.profile.network.kind, "restricted");
      return {
        sessionId: options.sessionSelection!.sessionId,
        sessionSelection: options.sessionSelection!,
        workDir: options.dir!,
        finalMessage: "Read only",
        messages: [],
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
      };
    },
  });

  const result = await execute({
    task: "Read a file",
    definition: requireSubagentCapability("local_read"),
  });

  assert.equal(result.permissionMode, "ask");
});

test("web research declares network in its managed child ceiling", () => {
  const boundary = configuredSubagentExecutionBoundary(requireSubagentCapability("web_research"));
  assert.equal(boundary.kind, "managed");
  if (boundary.kind !== "managed") return;
  assert.equal(boundary.profile.network.kind, "enabled");
  assert.equal(
    boundary.profile.fileSystem.entries.some((entry) => entry.access === "write"),
    false,
  );
});

test("a read-only parent rejects a writable isolated child before worktree execution", async () => {
  const route = {
    id: "test/model",
    providerId: "test",
    provider: "openai" as const,
    model: "model",
    baseURL: "https://unused.example/v1",
    apiKeyEnv: "UNUSED",
    auth: "none" as const,
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", "model", undefined),
  };
  let childCalls = 0;
  const execute = createConfiguredSubagentExecutor({
    workDir: process.cwd(),
    modelRouter: new ModelRouter([route], {}, route.id),
    parentModelRouteId: route.id,
    parentExecutionBoundary: () =>
      createManagedExecutionBoundary(createReadOnlyPermissionProfile()),
    executeChild: async () => {
      childCalls++;
      throw new Error("must not execute");
    },
  });

  await assert.rejects(
    execute({
      task: "Attempt a write",
      definition: requireSubagentCapability("implementation"),
    }),
    /cannot create a writable isolated child/,
  );
  assert.equal(childCalls, 0);
});

test("Graph admission persists the selected preset and enforces worktree isolation across replay and deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-preset-graph-"));
  const f = fixture();
  f.set([{ ...(await f.catalog.list())[0]!, profile: "implementation" }]);
  const store = new SqliteAgentGraphControlStore({ storageRoot: root });
  const unreachable = async (): Promise<never> => {
    throw new Error("execution is deliberately not started");
  };
  const service = createAgentGraphApplicationService({
    store,
    operatorProfileCatalog: createConfiguredAgentGraphOperatorProfileCatalog(f.catalog),
    runtime: {
      ensureOperatorProvision: unreachable,
      startOrObserveActivation: unreachable,
      projectActivation: unreachable,
      stopActivation: unreachable,
      resolveInputHandoff: unreachable,
    },
    rootWakePort: { inspect: unreachable, startOrResume: unreachable },
    resolveOperatorWorkspace: unreachable,
  });
  try {
    const graph = service.openRootEpoch("parent");
    const input = {
      ...graph,
      rootModelRouteId: "parent/model",
      source: { sessionId: "parent", turnId: "turn", runId: "run", toolCallId: "schedule" },
      request: {
        operation: "add_work" as const,
        work: [
          {
            profileId: "reader-0",
            requireConfiguredPreset: true,
            workspace: { kind: "shared" as const },
            instruction: "Implement a bounded change",
            inputIds: [],
          },
        ],
      },
    };
    const result = await service.toolPort.commitWork!(input);
    const operator = result.projection.operators[0]!;
    assert.equal(operator.workspacePolicy.kind, "isolated-worktree");
    f.set([]);
    const replay = await service.toolPort.commitWork!(input);
    assert.equal(replay.replayed, true);
    const persisted = new SqliteAgentGraphControlStoreAdapter(store).getScheduleState(graph.graphId)
      .operators[0]!;
    assert.equal(persisted.profileSnapshot.subagentPreset?.name, "Reader 0");
    assertValidAgentGraphOperatorProfileSnapshot(persisted.profileSnapshot);
    await assert.rejects(
      service.toolPort.commitWork!({ ...input, source: { ...input.source, toolCallId: "new" } }),
      /unavailable/,
    );
  } finally {
    await service.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
