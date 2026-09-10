import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import { HookService } from "../../../src/hooks/service.js";
import type { HookEventPayloadMap } from "../../../src/hooks/types.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import { NO_FILE_SIDE_EFFECTS } from "../../../src/tools/registry.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

for (const persistence of [true, false]) {
  test(`Code Mode dispatches child post hooks after canonical settlement (durable=${persistence})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-code-hook-boundary-"));
    const runtimePort = createEngineRuntimePort();
    const session = new Session("code-hook-boundary", root, {
      persistence,
      picoHome: join(root, "home"),
      runtimePort,
    });
    t.after(async () => {
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    const posts: Array<{
      event: "PostToolUse" | "PostToolUseFailure";
      payload: HookEventPayloadMap["PostToolUse"];
    }> = [];
    const secret = "synthetic-private-child-value";
    const hookService = new HookService({
      workDir: root,
      sessionId: session.id,
      executor: {
        async execute() {
          return { decision: "allow" };
        },
      },
      decisionProviders: [
        {
          async evaluate(event, payload) {
            if (
              event === "PreToolUse" &&
              "tool_name" in payload &&
              payload.tool_name === "lookup"
            ) {
              return {
                decision: "allow",
                modifiedInput: { ...(payload.tool_input as object), value: 7 },
              };
            }
            if (event === "PostToolUse" || event === "PostToolUseFailure") {
              const post = payload as HookEventPayloadMap["PostToolUse"];
              if (persistence && post.tool_name === "lookup") {
                assert.ok(post.tool_call_id);
                const events = await session.runtimeEventStore!.readSession(session.id);
                const result = events.find(
                  (entry) =>
                    entry.kind === "tool.result.recorded" &&
                    entry.refs.toolCallId === post.tool_call_id,
                );
                assert.ok(
                  result?.kind === "tool.result.recorded",
                  "T2 must precede the child post hook",
                );
                assert.equal(result.visibility, "internal");
                const operation = await session.runtimeEventStore!.readToolOperation(
                  session.id,
                  currentRuntimeRun()!.runId,
                  post.tool_call_id,
                );
                assert.equal(operation?.state, "settled");
              }
              posts.push({ event, payload: structuredClone(post) });
            }
            return { decision: "allow" };
          },
        },
      ],
    });
    const registry = new ToolRegistry();
    registry.setHookService(hookService);
    registry.register({
      name: () => "lookup",
      readOnly: true,
      nesting: "nestable",
      fileSideEffects: NO_FILE_SIDE_EFFECTS,
      accesses: () => ToolAccesses.none(),
      definition: () => ({
        name: "lookup",
        description: "Bounded nested hook fixture",
        inputSchema: {
          type: "object",
          properties: { fail: { type: "boolean" }, value: { type: "number" } },
          required: ["fail", "value"],
        },
      }),
      async execute(args) {
        const input = JSON.parse(args) as { fail: boolean; value: number };
        assert.equal(input.value, 7);
        if (input.fail) throw new Error("fixture failure");
        return `${secret}:7`;
      },
    });
    registry.register(
      createCodeModeTool({
        registry,
        hookService,
        redactionSecrets: [secret],
        ...(persistence ? { getRuntimeRun: currentRuntimeRun } : {}),
      }),
    );
    let requests = 0;
    const engine = new AgentEngine({
      workDir: root,
      registry,
      runtimePort,
      hookService,
      reporter: new SilentReporter(),
      maxTurns: 3,
      provider: {
        async generate() {
          if (++requests === 1)
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "parent-exec",
                  name: "exec",
                  arguments: JSON.stringify({
                    code: "const ok = await tools.lookup({fail:false,value:1}); try { await tools.lookup({fail:true,value:2}); } catch {} return ok;",
                  }),
                },
              ],
            };
          return { role: "assistant", content: "done" };
        },
      },
    });
    await session.commitMessages({ role: "user", content: "Run the nested fixture." });
    await engine.run(session);
    assert.deepEqual(
      posts.map(({ event, payload }) => [event, payload.tool_name]),
      [
        ["PostToolUse", "lookup"],
        ["PostToolUseFailure", "lookup"],
        ["PostToolUse", "exec"],
      ],
    );
    assert.equal(posts[0]!.payload.tool_result.status, "succeeded");
    assert.equal(posts[1]!.payload.tool_result.status, "failed");
    assert.deepEqual(posts[0]!.payload.tool_input, { fail: false, value: 7 });
    assert.ok(!JSON.stringify(posts).includes(secret));
    assert.match(posts[0]!.payload.tool_result.projection.text, /\[REDACTED\]/);
    assert.equal(requests, 2);
  });
}
