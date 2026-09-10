import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { currentRuntimeRun } from "../../../src/runtime/runtime-run.js";
import { createCodeModeTool } from "../../../src/tools/code-mode-tool.js";
import { NO_FILE_SIDE_EFFECTS } from "../../../src/tools/registry.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

test("exec owns its provider Step, nested leaves remain callable and the next Step starts fresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-exclusive-step-"));
  const runtimePort = createEngineRuntimePort();
  const session = new Session("exclusive-step", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort,
  });
  t.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const registry = new ToolRegistry();
  const physicalCalls: string[] = [];
  registry.register({
    name: () => "lookup",
    nesting: "nestable",
    readOnly: true,
    recoveryMode: "replay_safe",
    recoveryKey: "fixture.lookup.v1",
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    accesses: () => ToolAccesses.none(),
    definition: () => ({ name: "lookup", description: "fixture", inputSchema: { type: "object" } }),
    async execute(_args, context) {
      physicalCalls.push(context?.parentToolCallId ?? context!.toolCallId!);
      return "7";
    },
  });
  registry.register(createCodeModeTool({ registry, getRuntimeRun: currentRuntimeRun }));
  const execCall = (id: string) => ({
    id,
    name: "exec",
    arguments: JSON.stringify({ code: "return await tools.lookup({});" }),
  });
  let requests = 0;
  const engine = new AgentEngine({
    registry,
    runtimePort,
    workDir: root,
    reporter: new SilentReporter(),
    maxTurns: 4,
    provider: {
      async generate() {
        requests++;
        const calls =
          requests === 1
            ? [execCall("exec-first"), { id: "late-lookup", name: "lookup", arguments: "{}" }]
            : requests === 2
              ? [{ id: "lookup-first", name: "lookup", arguments: "{}" }, execCall("late-exec")]
              : requests === 3
                ? [execCall("next-step-exec")]
                : [];
        return {
          role: "assistant",
          content: calls.length ? "" : "done",
          ...(calls.length ? { toolCalls: calls } : {}),
        };
      },
    },
  });
  await session.commitMessages({ role: "user", content: "Exercise Step admission." });
  await engine.run(session);
  assert.deepEqual(physicalCalls, ["exec-first", "lookup-first", "next-step-exec"]);
  const events = await session.runtimeEventStore!.readSession(session.id);
  for (const id of ["late-lookup", "late-exec"]) {
    assert.ok(
      !events.some((event) => event.kind === "tool.started" && event.refs?.toolCallId === id),
    );
    const result = events.find(
      (event) => event.kind === "tool.result.recorded" && event.refs.toolCallId === id,
    );
    assert.ok(result?.kind === "tool.result.recorded");
    assert.equal(result.data.status, "rejected");
    assert.match(result.data.projection.text, /did not run.*cannot share/);
  }
  assert.equal(requests, 4);
});
