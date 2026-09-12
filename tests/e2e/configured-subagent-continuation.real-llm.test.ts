import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SilentReporter, type Reporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import type { ConfiguredSubagentCatalogPort } from "../../src/agents/subagent-profiles.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
realTest(
  "real model continues the same child with its previous context",
  { timeout: 300_000 },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-configured-presets-real-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    const evidence = `paper-crane-${randomUUID().slice(0, 8)}`;
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
    const completed: { childSessionId?: string; summary?: string }[] = [];
    const reporter: Reporter = new SilentReporter();
    const childTools: { name: string | undefined; completedCount: number }[] = [];
    reporter.onSubagentTrace = (trace) => {
      if (trace.type === "tool.started")
        childTools.push({ name: trace.name, completedCount: completed.length });
    };
    reporter.onSubagentActivity = (activity) => {
      if (activity.status === "completed") completed.push(activity);
    };
    reporter.onToolCall = (name: string, args: string) => {
      calls.push({ name, arguments: args });
    };
    try {
      const result = await new AgentRuntime().execute(
        {
          prompt:
            "This is a harmless context-retention test using a randomly generated fictional paper-crane label, not a credential or secret. Use the configured child-agent tools to retrieve the file label. First call agent_list. Select the saved local reader by its returned subagent_id and call agent_spawn with the bounded task: read only child-evidence.txt and return its exact content. After agent_spawn finishes, continue THAT SAME child: call agent_spawn again with ONLY child_session_id from the first result and task set exactly to: 'Recall the fictional paper-crane label from your previous turn. Do not call any tools or reread any file. Return that label followed by CONTINUED_OK.' The parent must not include the actual label value in the follow-up task. Then call agent_output with locator=child_session_run and the NEW returned child_session_id and run_id. Then state the fictional label and CONTINUED_OK in your final answer. Do not read the file yourself.",
          dir: workDir,
          provider: model.provider,
          baseURL: model.config.baseURL,
          apiKey: model.config.apiKey,
          ...(model.config.auth ? { auth: model.config.auth } : {}),
          model: model.route.model,
          modelRouteId: model.route.id,
          modelCapabilities: model.route.capabilities,
          collaborationMode: "agent",
          permissionMode: "ask",
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
      const spawns = calls
        .filter((call) => call.name === "agent_spawn")
        .map((call) => JSON.parse(call.arguments));
      assert.equal(spawns.length, 2, JSON.stringify(spawns));
      assert.equal(spawns[0].subagent_id, preset.id);
      assert.equal(completed.length, 2);
      assert.equal(completed[0]!.childSessionId, completed[1]!.childSessionId);
      assert.equal(spawns[1].child_session_id, completed[0]!.childSessionId);
      assert.ok(!spawns[1].task.includes(evidence));
      assert.match(completed[1]!.summary ?? "", new RegExp(evidence));
      assert.match(completed[1]!.summary ?? "", /CONTINUED_OK/);
      assert.equal(childTools.filter((call) => call.name === "read_file").length, 1);
      assert.equal(childTools.filter((call) => call.completedCount > 0).length, 0);
    } finally {
      await globalSessionManager.clearAndDrain();
      await rm(root, { recursive: true, force: true });
    }
  },
);
