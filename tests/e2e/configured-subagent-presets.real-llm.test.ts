import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import type { ConfiguredSubagentCatalogPort } from "../../src/agents/subagent-profiles.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
realTest(
  "real model selects a saved preset, spawns a durable child and reads its persisted output",
  { timeout: 240_000 },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-configured-presets-real-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    const evidence = `SUBAGENT_${randomUUID().replaceAll("-", "")}`;
    await writeFile(join(workDir, "child-evidence.txt"), evidence, "utf8");
    const preset = {
      id: "saved-local-reader",
      name: "Saved Local Reader",
      description: "Read one named local file and return its exact content.",
      profile: "local_read" as const,
      connectionSlug: model.route.providerId,
      model: model.route.model,
      enabled: true,
    };
    const catalog: ConfiguredSubagentCatalogPort = {
      async list() {
        return [{ ...preset, availability: { status: "available" } }];
      },
      async resolve(id) {
        assert.equal(id, preset.id);
        return { ...preset, modelRouteId: model.route.id };
      },
    };
    const calls: { name: string; arguments: string }[] = [];
    const reporter = new SilentReporter();
    reporter.onToolCall = (name: string, args: string) => {
      calls.push({ name, arguments: args });
    };
    try {
      const result = await new AgentRuntime().execute(
        {
          prompt:
            "Use the configured child-agent tools to retrieve a file token. First call agent_list. Select the saved local reader by its returned subagent_id and call agent_spawn with the bounded task: read only child-evidence.txt and return its exact content. After agent_spawn finishes, call agent_output with locator=child_session_run and the returned child_session_id and run_id (map from childSessionId/runId). Then state the exact file token in your final answer. Do not read the file yourself, and do not use legacy delegate_task or spawn_subagent.",
          dir: workDir,
          provider: model.provider,
          baseURL: model.config.baseURL,
          apiKey: model.config.apiKey,
          ...(model.config.auth ? { auth: model.config.auth } : {}),
          model: model.route.model,
          modelRouteId: model.route.id,
          modelCapabilities: model.route.capabilities,
          interactionMode: "default",
          allowedTools: ["agent_list", "agent_spawn", "agent_output"],
        },
        {
          picoHome,
          env: { PATH: process.env.PATH },
          reporter,
          modelRouter: model.runtime.router,
          configuredSubagentCatalog: catalog,
          hostKind: "desktop",
          maxTurns: 8,
        },
      );
      assert.match(result.finalMessage, new RegExp(evidence));
      const names = calls.map((call) => call.name);
      assert.ok(names.indexOf("agent_list") >= 0);
      assert.ok(names.indexOf("agent_spawn") > names.indexOf("agent_list"));
      assert.ok(names.indexOf("agent_output") > names.indexOf("agent_spawn"));
      const spawn = JSON.parse(calls.find((call) => call.name === "agent_spawn")!.arguments);
      assert.equal(spawn.subagent_id, preset.id);
    } finally {
      await globalSessionManager.clearAndDrain();
      await rm(root, { recursive: true, force: true });
    }
  },
);
