import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LLMProvider, RequestContextFacts } from "@pico/core";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { currentRuntimeRun, RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import type { SessionRuntime } from "@pico/pico-host/session-runtime";
import { bindRuntimeHookCapabilities } from "../../../packages/pico-host/src/runtime-hook-assembly.js";

type Binding = Parameters<SessionRuntime["bindHookRuntime"]>[0];
const summary =
  "## Goal\nVerify TOKEN-42.\n## Progress\n### Done\nRead evidence.\n### In Progress\nCheck result.\n## Key Decisions\nRead only.\n## Next Steps\nReturn JSON.\n## Critical Context\nTOKEN-42 is verified.";

for (const mode of ["compact", "limit"] as const) {
  test(`Hook verifier uses isolated durable main loop: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-hook-compact-"));
    const parent = new Session("parent", root, {
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    });
    let binding: Binding | undefined;
    let childId = "";
    let steps = 0;
    let summaries = 0;
    const purposes: unknown[] = [];
    const requestContexts: (RequestContextFacts | undefined)[] = [];
    const provider: LLMProvider = {
      async generate(messages, tools, options) {
        purposes.push(options?.purpose);
        const run = currentRuntimeRun()!;
        assert.notEqual(run.sessionId, parent.id);
        childId = run.sessionId;
        if (options?.maxOutputTokens === 8000) {
          summaries++;
          return { role: "assistant", content: summary };
        }
        steps++;
        requestContexts.push(options?.contextFacts);
        assert.ok(
          !tools.some((tool) => ["write_file", "edit_file", "agent_swarm"].includes(tool.name)),
        );
        if (mode === "limit") {
          assert.equal(
            tools.length,
            0,
            "one-turn verifier reserves its only call for final output",
          );
          return { role: "assistant", content: '{"ok":true,"reason":"TOKEN-42"}' };
        }
        assert.ok(tools.some((tool) => tool.name === "archive_read"));
        if (steps <= 2)
          return {
            role: "assistant",
            content: "",
            usage: { promptTokens: steps === 1 ? 100 : 9000, completionTokens: 500 },
            toolCalls: [
              {
                id: `read-${steps}`,
                name: "read_file",
                arguments: JSON.stringify({ path: "evidence.txt" }),
              },
            ],
          };
        assert.ok(
          messages.some((message) => message.content.includes("<pico_compaction_summary>")),
        );
        assert.ok(messages.some((message) => message.content.includes("TOKEN-42")));
        return { role: "assistant", content: '{"ok":true,"reason":"TOKEN-42"}' };
      },
    };
    try {
      await parent.recover();
      await parent.commitMessages({ role: "user", content: "Parent must remain unchanged" });
      const before = structuredClone(parent.getHistory());
      await writeFile(join(root, "evidence.txt"), "Evidence TOKEN-42\n".repeat(600));
      bindRuntimeHookCapabilities({
        session: parent,
        runtimeState: {
          bindHookRuntime(value: Binding) {
            binding = value;
          },
        } as SessionRuntime,
        provider,
        workDir: root,
        workspaceRoots: WorkspaceRoots.createSync(root),
        picoHome: join(root, "home"),
        runtimeEnv: {},
        sandboxConfig: { network: "deny" },
        mcpManager: () => undefined,
        contextRouteIdentity: "hook-route",
        contextBudget: {
          contextWindowTokens: 10000,
          declaredContextWindowTokens: 10000,
          reservedOutputTokens: 1000,
          safetyMarginTokens: 100,
          inputBudgetTokens: 8900,
        },
      });
      await parent.serialize(async () => {
        const run = await RuntimeRun.start({
          capability: parent.runtimeEventCapability!,
          agentSwarmAuthorization: "none",
        });
        await run.run(async () => {
          const result = await binding!.agentVerifier!.verify({
            prompt: "Verify TOKEN-42",
            input: {
              session_id: parent.id,
              cwd: root,
              hook_event_name: "Stop",
              payload: { reason: "test" },
            },
            maxTurns: mode === "limit" ? 1 : 4,
            readonlyToolsOnly: true,
            suppressHooks: true,
            signal: new AbortController().signal,
          });
          assert.deepEqual(JSON.parse(String(result)), { ok: true, reason: "TOKEN-42" });
          assert.equal(currentRuntimeRun(), run, "parent capability restored");
        });
      });
      assert.deepEqual(parent.getHistory(), before);
      assert.ok(purposes.every((purpose) => purpose === "hook"));
      assert.equal(summaries, mode === "compact" ? 1 : 0);
      assert.equal(steps, mode === "compact" ? 3 : 1);
      const childEvents = await parent.runtimeEventStore!.readSession(childId);
      assert.ok(childEvents.some((event) => event.kind === "run.terminal"));
      if (mode === "compact") {
        const checkpoint = childEvents.find(
          (event) => event.kind === "context.checkpoint.recorded",
        );
        assert.ok(checkpoint?.kind === "context.checkpoint.recorded");
        assert.equal(
          requestContexts.at(-1)?.compaction?.checkpointId,
          checkpoint.data.checkpointId,
        );
        assert.ok(
          childEvents.some(
            (event) =>
              event.kind === "tool.result.projection.recorded" &&
              event.data.projection.text.includes("pico://archive/"),
          ),
        );
        assert.ok(
          childEvents.some(
            (event) =>
              event.kind === "tool.result.recorded" && event.data.projection.mode === "full",
          ),
        );
        assert.ok(
          !(await parent.runtimeEventStore!.readSession(parent.id)).some(
            (event) => event.kind === "context.checkpoint.recorded",
          ),
        );
      }
    } finally {
      await parent.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
