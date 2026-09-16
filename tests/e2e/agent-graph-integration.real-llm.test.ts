import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import { globalSessionManager } from "@pico/pico-host/session";
import {
  UserConfigStore,
  EMPTY_USER_CONFIG_REVISION,
} from "@pico/pico-host/input/user-config-store";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "@pico/pico-host/product-agent-graph-host";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "@pico/pico-host";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const exec = promisify(execFile);
const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
const terminal = new Set(["succeeded", "failed", "cancelled"]);
function workspaceKind(binding: unknown): unknown {
  assert.ok(binding && typeof binding === "object" && "kind" in binding);
  return binding.kind;
}

realModelTest(
  "Graph integrates two isolated commits before finish with the real model",
  { timeout: 300_000 },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-graph-integration-real-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await mkdir(picoHome);
    const workspacePath = await realpath(workDir);
    const git = async (...args: string[]) =>
      (await exec("git", args, { cwd: workspacePath })).stdout.trim();
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        compatibility: {
          claude: { enabled: false, projectResources: false, userResources: false },
        },
      }),
    );
    await writeFile(join(workDir, ".gitignore"), ".worktrees/\n");
    await writeFile(join(workDir, "README.md"), "Synthetic Graph integration test only.\n");
    await git("init", "-b", "main");
    await git("config", "user.name", "Pico Acceptance");
    await git("config", "user.email", "acceptance@example.invalid");
    await git("add", ".");
    await git("commit", "-m", "test: synthetic baseline");
    const base = await git("rev-parse", "HEAD");
    const userConfigStore = new UserConfigStore({ picoHome });
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: model.route.id },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv: model.route.apiKeyEnv,
            models: [model.route.model],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    await new WorkspaceTrustStore({ userStateDirectory: picoHome }).trust(workspacePath);
    let graphHost: AgentGraphWorkspaceHost | undefined;
    const services = await createProductionRuntimeServices({
      env: { ...process.env, PICO_HOME: picoHome, [model.route.apiKeyEnv]: model.config.apiKey },
      userConfigStore,
      credentialVault: {
        capability: () => ({
          available: true,
          backend: "macos-keychain",
          diagnostic: "test memory only",
        }),
        has: async () => true,
        resolve: async () => model.config.apiKey,
        put: async () => undefined,
        delete: async () => undefined,
      },
      agentGraphWorkspaceHostFactory: (options) =>
        (graphHost = createAgentGraphWorkspaceHost(options)),
    });
    const rootSessionId = `graph-integration-${randomUUID()}`;
    const runtime = await services.service.getWorkspaceRuntime(workspacePath);
    try {
      const lease = await globalSessionManager.getOrCreatePinned(rootSessionId, workspacePath, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        lease.session.updateRuntimeState({
          boundary: { kind: "bypass", revision: 0 },
          settings: {
            provider: model.provider,
            model: model.route.model,
            modelRouteId: model.route.id,
            collaborationMode: "agent",
            permissionMode: "full-access",
            orchestrationMode: "graph",
            thinkingEffort: "off",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
        });
        await lease.session.flushPersistence();
      } finally {
        lease.release();
      }
      await services.service.startForegroundRun({
        workspacePath,
        sessionId: rootSessionId,
        prompt: [
          "在此合成 Git 项目验收并行实现与最终交付。通过一次调度并行派发两个互不依赖的可写子任务，分别使用独立 isolated-worktree。",
          "A 只创建 alpha.txt，内容精确为 GRAPH_ALPHA_OK 加一个换行；B 只创建 beta.txt，内容精确为 GRAPH_BETA_OK 加一个换行。各自提交并报告分支、完整提交 SHA 和文件内容。",
          "最终须将两个真实提交都整合进主项目 main，读取文件验证精确内容后才算完成；禁止在主项目重新写同样文件来替代合并。",
          "不要修改其他文件、不 push、不访问网络或本合成项目以外的数据。使用仓库已配置的 Git 身份。",
        ].join("\n"),
        execution: {
          requestedModel: model.route.id,
          allowedTools: ["view_agent_graph", "update_agent_graph", "yield_agent_graph"],
        },
      });
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const graph = graphHost?.store.listGraphs(rootSessionId)[0];
        const runs = runtime.listRuns();
        if (graph?.phase === "finished" && runs.every((run) => terminal.has(run.status))) break;
        const failed = runs.find((run) => run.status === "failed");
        assert.equal(failed?.status, undefined, "no Graph Run may fail");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const graph = graphHost?.store.listGraphs(rootSessionId)[0];
      assert.ok(graph && graphHost, "real production Graph must exist");
      assert.equal(graph.phase, "finished", "Graph must finish within the bounded deadline");
      assert.ok(
        runtime.listRuns().every((run) => run.status === "succeeded"),
        JSON.stringify(
          runtime.listRuns().map((run) => ({
            status: run.status,
            error: run.error?.replaceAll(model.config.apiKey, "[redacted]").slice(0, 500),
          })),
        ),
      );
      assert.equal(await readFile(join(workspacePath, "alpha.txt"), "utf8"), "GRAPH_ALPHA_OK\n");
      assert.equal(await readFile(join(workspacePath, "beta.txt"), "utf8"), "GRAPH_BETA_OK\n");
      assert.equal(await git("status", "--porcelain"), "");
      const isolated = graphHost.store
        .listOperatorProvisions(graph.graphId)
        .filter((provision) => workspaceKind(provision.workspaceBinding) === "isolated-worktree");
      assert.equal(isolated.length, 2, "both initial writers must use isolated worktrees");
      const commits = (await git("rev-list", `${base}..main`, "--no-merges")).split("\n");
      for (const file of ["alpha.txt", "beta.txt"]) {
        let matches = 0;
        for (const sha of commits) {
          if ((await git("diff-tree", "--no-commit-id", "--name-only", "-r", sha)) === file)
            matches++;
        }
        assert.equal(matches, 1, `${file} must have one original commit reachable from main`);
      }
      assert.ok(
        Number(await git("rev-list", "--count", "--merges", `${base}..main`)) >= 1,
        "real merge history required",
      );
      const eventStore = new SqliteRuntimeEventStore({
        storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root,
      });
      try {
        const rootEvents = await eventStore.readSession(rootSessionId);
        const starts = rootEvents.filter((event) => event.kind === "tool.started");
        assert.ok(
          starts.every((event) =>
            ["view_agent_graph", "update_agent_graph", "yield_agent_graph"].includes(
              event.data.toolName,
            ),
          ),
          "root must retain its supervisor-only tool boundary",
        );
        const shared = graphHost.store
          .listOperatorProvisions(graph.graphId)
          .filter((provision) => workspaceKind(provision.workspaceBinding) === "shared");
        assert.ok(shared.length >= 1, "integration must be delegated before finish");
        const intervals: { start: number; end: number }[] = [];
        for (const provision of isolated) {
          const events = await eventStore.readSession(provision.childSessionId);
          const start = events.find((event) => event.kind === "run.started");
          const end = events.find((event) => event.kind === "run.terminal");
          assert.ok(start && end);
          intervals.push({ start: Date.parse(start.at), end: Date.parse(end.at) });
        }
        assert.ok(
          Math.min(...intervals.map((i) => i.end)) > Math.max(...intervals.map((i) => i.start)),
          "writer Runs must actually overlap",
        );
        for (const provision of shared) {
          const events = await eventStore.readSession(provision.childSessionId);
          const output = events.find((event) => event.kind === "agent.output");
          assert.ok(
            output && Date.parse(output.at) <= graph.finishedAt!,
            "integration output must precede finish",
          );
        }
      } finally {
        eventStore.close();
      }
    } finally {
      for (const run of runtime.listRuns())
        if (!terminal.has(run.status)) runtime.cancel(run.runId, "E2E cleanup");
      const sessionIds = new Set([
        rootSessionId,
        ...(graphHost?.store
          .listGraphs(rootSessionId)
          .flatMap((graph) =>
            graphHost!.store.listOperatorProvisions(graph.graphId).map((p) => p.childSessionId),
          ) ?? []),
      ]);
      await services.desktopService.close();
      for (const id of sessionIds)
        await globalSessionManager.delete(id, workspacePath, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
