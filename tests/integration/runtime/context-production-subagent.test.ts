import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRuntime } from "@pico/pico-host/agent-runtime";
import { ModelRouter } from "@pico/pico-host/provider/model-router";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { currentRuntimeRun } from "@pico/runtime/runtime-run";
import { Session, globalSessionManager } from "@pico/pico-host/session";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import type { ConfiguredSubagentCatalogPort } from "@pico/core/subagent-capabilities";
import type { Message, RequestContextFacts } from "@pico/core";
import { reportFixtureAttempt } from "../../fixtures/native-accounting.js";
import { contextSummaryBody } from "../../fixtures/context-summary.js";

test("configured agent_spawn uses durable engine compaction, resumes the same child, and never changes parent history", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-context-production-child-")));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await writeFile(join(workDir, "evidence.txt"), "CHILD_TOKEN_42 preserved evidence\n".repeat(600));
  t.after(async () => {
    await globalSessionManager.clearAndDrain();
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
    capabilities: resolveModelRouteCapabilities("openai", "glm-5.2", {
      context: 10000,
      output: 1000,
    }),
  };
  const catalog: ConfiguredSubagentCatalogPort = {
    async list() {
      return [];
    },
    async resolve(id) {
      assert.equal(id, "context-reader");
      return {
        id,
        name: "Context reader",
        description: "Inspect evidence",
        profile: "local_read",
        connectionSlug: "fixture",
        model: route.model,
        enabled: true,
        modelRouteId: route.id,
      };
    },
  };
  const parentId = "context-production-parent";
  let childId = "";
  let parentCalls = 0;
  let childCalls = 0;
  let summaries = 0;
  const childRunIds = new Set<string>();
  const contexts: (RequestContextFacts | undefined)[] = [];
  const spawn = (id: string, args: Record<string, string>): Message => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id, name: "agent_spawn", arguments: JSON.stringify(args) }],
  });
  const result = await new AgentRuntime().execute(
    {
      prompt: "Delegate evidence reading and resume it once",
      dir: workDir,
      sessionSelection: { mode: "new", sessionId: parentId },
      modelRouteId: route.id,
      provider: route.provider,
      model: route.model,
      auth: route.auth,
      baseURL: route.baseURL,
      collaborationMode: "agent",
      permissionMode: "ask",
    },
    {
      picoHome,
      modelRouter: new ModelRouter([route], {}, route.id),
      configuredSubagentCatalog: catalog,
      reporter: new SilentReporter(),
      hostKind: "desktop",
      maxTurns: 6,
      providerFactory: () => ({
        async generate(messages, tools, options) {
          const run = currentRuntimeRun()!;
          const usage = { promptTokens: 100, completionTokens: 30 };
          if (run.sessionId === parentId) {
            parentCalls++;
            await reportFixtureAttempt(options, "openai", route.model, usage);
            assert.ok(tools.some((tool) => tool.name === "agent_spawn"));
            assert.equal(options?.contextFacts?.compaction, undefined);
            if (parentCalls === 1)
              return {
                ...spawn("spawn-child", {
                  subagent_id: "context-reader",
                  task: "Read evidence.txt twice and retain CHILD_TOKEN_42",
                }),
                usage,
              };
            const childResult = JSON.parse(
              messages.find(
                (message) =>
                  message.toolCallId === (parentCalls === 2 ? "spawn-child" : "resume-child"),
              )!.content,
            );
            assert.equal(childResult.status, "completed");
            assert.equal(childResult.sessionId, childId);
            if (parentCalls === 2)
              return {
                ...spawn("resume-child", {
                  child_session_id: childId,
                  task: "Recall CHILD_TOKEN_42 and respond with RESUMED_73",
                }),
                usage,
              };
            return { role: "assistant", content: "parent complete", usage };
          }
          childId = run.sessionId;
          childRunIds.add(run.runId);
          if (options?.maxOutputTokens === 8000) {
            summaries++;
            await reportFixtureAttempt(options, "openai", route.model, usage);
            return {
              role: "assistant",
              content: contextSummaryBody("CHILD_TOKEN_42; evidence.txt was verified."),
              usage,
            };
          }
          childCalls++;
          contexts.push(options?.contextFacts);
          assert.ok(
            !tools.some((tool) => ["write_file", "agent_spawn", "agent_swarm"].includes(tool.name)),
          );
          if (childCalls <= 2) {
            const measured = { promptTokens: childCalls === 1 ? 100 : 9000, completionTokens: 500 };
            await reportFixtureAttempt(options, "openai", route.model, measured);
            return {
              role: "assistant",
              content: "",
              usage: measured,
              toolCalls: [
                {
                  id: `child-read-${childCalls}`,
                  name: "read_file",
                  arguments: '{"path":"evidence.txt"}',
                },
              ],
            };
          }
          assert.ok(
            options?.contextFacts?.compaction,
            "production child forwards its applied checkpoint",
          );
          assert.ok(
            messages.some((message) => message.content.includes("<pico_compaction_summary>")),
          );
          assert.ok(messages.some((message) => message.content.includes("CHILD_TOKEN_42")));
          await reportFixtureAttempt(options, "openai", route.model, usage);
          return {
            role: "assistant",
            content: childCalls === 3 ? "CHILD_TOKEN_42 verified" : "CHILD_TOKEN_42 RESUMED_73",
            usage,
          };
        },
      }),
    },
  );
  assert.equal(result.sessionId, parentId);
  assert.equal(parentCalls, 3);
  assert.equal(childCalls, 4);
  assert.equal(summaries, 1);
  assert.equal(childRunIds.size, 2);
  assert.notEqual(childId, parentId);
  assert.equal(
    contexts.at(-1)?.compaction?.checkpointId,
    contexts.at(-2)?.compaction?.checkpointId,
  );
  await globalSessionManager.clearAndDrain();
  const parent = new Session(parentId, workDir, { persistence: true, picoHome });
  await parent.recover();
  try {
    const parentEvents = await parent.runtimeEventStore!.readSession(parentId);
    const childEvents = await parent.runtimeEventStore!.readSession(childId);
    assert.equal(
      parentEvents.filter((event) => event.kind === "context.checkpoint.recorded").length,
      0,
    );
    const checkpoints = childEvents.filter((event) => event.kind === "context.checkpoint.recorded");
    assert.equal(checkpoints.length, 1);
    assert.ok(
      childEvents.some((event) => event.kind === "tool.result.projection.recorded"),
      "configured child must retain a session-bound archive reader after tool restriction",
    );
    assert.ok(
      childEvents.some(
        (event) => event.kind === "tool.result.recorded" && event.data.projection.mode === "full",
      ),
    );
    assert.equal(childEvents.filter((event) => event.kind === "run.terminal").length, 2);
  } finally {
    await parent.close();
  }
});
