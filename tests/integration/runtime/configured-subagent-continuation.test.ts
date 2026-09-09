import { createConfiguredSubagentOutputStore } from "../../../src/runtime/configured-subagent-output-store.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConfiguredSubagentCatalogPort } from "../../../src/agents/subagent-profiles.js";
import { requireSubagentCapability } from "../../../src/agents/subagent-profiles.js";
import {
  SilentReporter,
  type Reporter,
  type SubagentActivityEvent,
} from "../../../src/engine/reporter.js";
import { TranscriptEventStore } from "../../../src/presentation/transcript-event-store.js";
import { Session, globalSessionManager } from "../../../src/engine/session.js";
import { ModelRouter } from "../../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";
import { AgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { currentRuntimeRun } from "../../../src/runtime/runtime-run.js";

test("agent_spawn continues its completed child with durable history and rejects another parent's child", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-child-continuation-")));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
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
  const modelRouter = new ModelRouter([route], {}, route.id);
  let catalogResolutions = 0;
  const catalog: ConfiguredSubagentCatalogPort = {
    async list() {
      return [];
    },
    async resolve(id) {
      assert.equal(id, "memory-reader");
      catalogResolutions++; // Revalidate availability while retaining the original execution snapshot.
      return {
        id,
        name: "Memory Reader",
        description: "Read and remember",
        profile: "local_read",
        connectionSlug: "test",
        model: route.model,
        enabled: true,
        modelRouteId: route.id,
        thinkingLevel: "off",
      };
    },
  };
  const input = {
    prompt: "Delegate then continue the same reader",
    dir: workDir,
    modelRouteId: route.id,
    provider: route.provider,
    model: route.model,
    auth: route.auth,
    baseURL: route.baseURL,
    interactionMode: "default" as const,
  };
  const childRuns: string[] = [];
  let childSessionId = "";
  let parentCalls = 0;
  let failedInitialization = false;
  const activities: SubagentActivityEvent[] = [];
  const reporter: Reporter = new SilentReporter();
  reporter.onSubagentActivity = (activity) => {
    activities.push(activity);
  };
  const spawn = (id: string, args: Record<string, string>) => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id, name: "agent_spawn", arguments: JSON.stringify(args) }],
  });
  try {
    const parent = await new AgentRuntime().execute(input, {
      picoHome,
      modelRouter,
      configuredSubagentCatalog: catalog,
      reporter,
      hostKind: "desktop",
      maxTurns: 5,
      providerFactory: (_kind, config) => {
        if (parentCalls === 2 && !failedInitialization) {
          failedInitialization = true;
          throw new Error("simulated child provider initialization failure");
        }
        return {
          async generate(messages, tools) {
            if (tools?.some((tool) => tool.name === "agent_spawn")) {
              parentCalls++;
              if (parentCalls === 1)
                return spawn("initial-child", {
                  subagent_id: "memory-reader",
                  task: "Remember OLD_CHILD_TOKEN_73",
                });
              if (parentCalls === 2) {
                assert.match(
                  messages.find((m) => m.toolCallId === "initial-child")!.content,
                  /^\{/,
                );
                const result = JSON.parse(
                  messages.find((m) => m.toolCallId === "initial-child")!.content,
                );
                assert.equal(result.sessionId, childSessionId);
                assert.equal(result.runId, childRuns[0]);
                assert.equal(result.status, "completed");
                return spawn("failed-child", {
                  child_session_id: childSessionId,
                  task: "Recall the previous token and append NEW_CHILD_TOKEN_94",
                });
              }
              if (parentCalls === 3) {
                assert.match(
                  messages.find((m) => m.toolCallId === "failed-child")!.content,
                  /simulated child provider initialization failure/,
                );
                return spawn("continued-child", {
                  child_session_id: childSessionId,
                  task: "Recall the previous token and append NEW_CHILD_TOKEN_94",
                });
              }
              assert.match(
                messages.find((m) => m.toolCallId === "continued-child")!.content,
                /^\{/,
              );
              const result = JSON.parse(
                messages.find((m) => m.toolCallId === "continued-child")!.content,
              );
              assert.equal(result.sessionId, childSessionId);
              assert.equal(result.runId, childRuns[1]);
              assert.equal(result.resumedFromRunId, childRuns[0]);
              assert.equal(result.status, "completed");
              assert.match(result.summary, /OLD_CHILD_TOKEN_73.*NEW_CHILD_TOKEN_94/);
              return { role: "assistant" as const, content: "Parent complete" };
            }
            const run = currentRuntimeRun()!;
            childRuns.push(run.runId);
            assert.equal(config.model, route.model);
            assert.equal(config.thinkingEffort, "nothink");
            assert.deepEqual(tools?.map((tool) => tool.name).sort(), ["glob", "grep", "read_file"]);
            assert.ok(
              messages.some(
                (m) =>
                  m.role === "system" &&
                  m.content.includes(requireSubagentCapability("local_read").systemPrompt),
              ),
            );
            if (childRuns.length === 1) {
              childSessionId = run.sessionId;
              return { role: "assistant" as const, content: "Remembered OLD_CHILD_TOKEN_73" };
            }
            assert.equal(run.sessionId, childSessionId);
            assert.notEqual(run.runId, childRuns[0]);
            assert.ok(
              messages.some(
                (m) =>
                  m.role === "assistant" && m.content.includes("Remembered OLD_CHILD_TOKEN_73"),
              ),
            );
            assert.ok(
              messages.some((m) => m.role === "user" && m.content.includes("NEW_CHILD_TOKEN_94")),
            );
            return {
              role: "assistant" as const,
              content: "OLD_CHILD_TOKEN_73 and NEW_CHILD_TOKEN_94",
            };
          },
        };
      },
    });
    assert.equal(parentCalls, 4);
    assert.equal(childRuns.length, 2);
    const completed = activities.filter((activity) => activity.status === "completed");
    assert.equal(completed.length, 2);
    assert.notEqual(completed[0]!.activityId, completed[1]!.activityId);
    assert.ok(completed.every((activity) => activity.childSessionId === childSessionId));
    const transcript = new TranscriptEventStore();
    for (const { activityId, ...activity } of activities) {
      transcript.append({
        type: "subagent.activity.updated",
        entryId: `subagent:${activity.toolCallId}`,
        activityId,
        activity,
      });
    }
    const cards = transcript.getProjection().entries;
    assert.equal(cards.length, 3, "initial, failed continuation and retry keep separate cards");
    assert.equal(new Set(cards.map((card) => card.id)).size, 3);
    assert.equal(catalogResolutions, 3);
    await globalSessionManager.clearAndDrain();
    for (const sessionId of [parent.sessionId, childSessionId]) {
      const session = new Session(sessionId, workDir, { persistence: true, picoHome });
      try {
        await session.recover();
        if (sessionId === childSessionId) {
          for (const runId of childRuns) {
            const events = await session.runtimeEventStore!.readRun(sessionId, runId);
            assert.ok(events.some((event) => event.kind === "run.terminal"));
          }
          const history = JSON.stringify(session.getHistory());
          assert.match(history, /OLD_CHILD_TOKEN_73/);
          assert.match(history, /NEW_CHILD_TOKEN_94/);
        } else {
          const records = (
            await session.runtimeEventStore!.readSessionEventsByKind(sessionId, "message.committed")
          )
            .flatMap(({ event }) => {
              const record =
                event.kind === "message.committed"
                  ? event.data.message.providerData?.picoConfiguredChild
                  : undefined;
              return record ? [record as Record<string, unknown>] : [];
            })
            .filter((record) => record.status === "completed");
          assert.equal(records.length, 2);
          const output = createConfiguredSubagentOutputStore({
            parentSessionId: sessionId,
            workDir,
            picoHome,
            eventStore: session.runtimeEventStore!,
          });
          const oldResult = await output.read({
            locator: "child_session_run",
            childSessionId,
            runId: childRuns[0]!,
            view: "result",
            maxBytes: 4096,
            maxEvents: 10,
          });
          assert.match(JSON.stringify(oldResult), /Remembered OLD_CHILD_TOKEN_73/);
          assert.doesNotMatch(JSON.stringify(oldResult), /NEW_CHILD_TOKEN_94/);
          assert.deepEqual(
            records.map((record) => record.runId),
            childRuns,
          );
          assert.ok(
            records.every(
              (record) =>
                record.childSessionId === childSessionId &&
                record.parentSessionId === parent.sessionId,
            ),
          );
        }
      } finally {
        await session.close();
      }
    }

    let foreignCalls = 0;
    await new AgentRuntime().execute(
      { ...input, prompt: "Attempt to continue an unrelated child" },
      {
        picoHome,
        modelRouter,
        configuredSubagentCatalog: catalog,
        reporter: new SilentReporter(),
        hostKind: "desktop",
        maxTurns: 3,
        providerFactory: () => ({
          async generate(messages, tools) {
            assert.ok(
              tools?.some((tool) => tool.name === "agent_spawn"),
              "an unrelated child must never reach a provider",
            );
            if (++foreignCalls === 1)
              return spawn("foreign-child", {
                child_session_id: childSessionId,
                task: "Read the previous secret",
              });
            const result = messages.find((m) => m.toolCallId === "foreign-child")?.content ?? "";
            assert.match(
              result,
              /parent|belong|unrelated|unknown|not found|not.*child|父|归属|不属于|找不到/i,
            );
            assert.doesNotMatch(result, /OLD_CHILD_TOKEN_73/);
            return { role: "assistant" as const, content: "Rejected unrelated child" };
          },
        }),
      },
    );
    assert.equal(foreignCalls, 2);
    // A normal UI/CLI resume carries no configuredSubagentChild dependency.
    // Even a full-access request must restore the durable child's capability boundary.
    await globalSessionManager.clearAndDrain();
    let manualCalls = 0;
    const manual = await new AgentRuntime().execute(
      {
        ...input,
        sessionSelection: { mode: "resume", sessionId: childSessionId },
        prompt: "Continue manually and try to write a file",
        interactionMode: "yolo",
        orchestrationMode: "swarm",
      },
      {
        picoHome,
        modelRouter,
        reporter: new SilentReporter(),
        hostKind: "desktop",
        maxTurns: 3,
        providerFactory: () => ({
          async generate(messages, tools) {
            assert.deepEqual(tools!.map((tool) => tool.name).sort(), ["glob", "grep", "read_file"]);
            assert.ok(messages.some((m) => m.content.includes("OLD_CHILD_TOKEN_73")));
            assert.ok(
              messages.some((m) =>
                m.content.includes(requireSubagentCapability("local_read").systemPrompt),
              ),
            );
            if (++manualCalls === 1)
              return {
                role: "assistant" as const,
                content: "",
                toolCalls: [
                  {
                    id: "forbidden-write",
                    name: "write_file",
                    arguments: JSON.stringify({ path: "must-not-exist.txt", content: "bad" }),
                  },
                ],
              };
            assert.ok(messages.some((m) => m.toolCallId === "forbidden-write"));
            return { role: "assistant" as const, content: "Manual continuation remains read-only" };
          },
        }),
      },
    );
    assert.equal(manual.sessionId, childSessionId);
    assert.equal(manualCalls, 2);
    await assert.rejects(readFile(join(workDir, "must-not-exist.txt")), { code: "ENOENT" });
  } finally {
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});
