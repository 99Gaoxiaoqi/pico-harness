import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { materializeRuntimeHistory } from "../../src/engine/session-runtime-read-model.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/runtime/runtime-event.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

test("Reporter failure happens after canonical ToolResult commit and keeps Session writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-reporter-order-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-result-reporter-order", workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    const registry = new ToolRegistry({ truncateResults: false });
    registry.register(outputTool("reporter_fixture", "actual output"));
    const provider: LLMProvider = {
      async generate() {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:reporter-fixture",
              name: "reporter_fixture",
              arguments: "{}",
            },
          ],
        };
      },
    };
    const reporterFailure = new Error("fixture Reporter failed");
    const reporter = new (class extends SilentReporter {
      override onToolResult(): void {
        throw reporterFailure;
      }
    })();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter,
      maxTurns: 2,
    });

    await assert.rejects(engine.run(session), reporterFailure);

    const events = await session.runtimeEventStore!.readSession(session.id);
    const recorded = events.find(
      (event): event is RuntimeToolResultRecordedEvent =>
        event.kind === "tool.result.recorded" && event.refs.toolCallId === "call:reporter-fixture",
    );
    assert.ok(recorded);
    assert.equal(recorded.data.status, "succeeded");
    assert.equal(recorded.data.body.storage, "inline");
    if (recorded.data.body.storage !== "inline") {
      assert.fail("fixture ToolResult must remain inline");
    }
    assert.equal(recorded.data.body.content, "actual output");
    assert.equal(recorded.data.projection.text, "actual output");
    assert.equal(events.filter((event) => event.kind === "tool.result.recorded").length, 1);
    const terminal = events.find(
      (event) => event.kind === "run.terminal" && event.runId === recorded.runId,
    );
    assert.ok(terminal?.kind === "run.terminal");
    assert.equal(terminal.data.status, "failed");

    const history = materializeRuntimeHistory(events);
    assert.deepEqual(
      history.slice(-2).map((message) => ({
        toolCalls: message.toolCalls,
        toolCallId: message.toolCallId,
        content: message.content,
      })),
      [
        {
          toolCalls: [
            {
              id: "call:reporter-fixture",
              name: "reporter_fixture",
              arguments: "{}",
            },
          ],
          toolCallId: undefined,
          content: "",
        },
        {
          toolCalls: undefined,
          toolCallId: "call:reporter-fixture",
          content: "actual output",
        },
      ],
    );

    await session.commitMessages({ role: "user", content: "Session remains writable." });
    assert.equal(session.getHistory().at(-1)?.content, "Session remains writable.");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

function outputTool(name: string, output: string): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => name,
    definition: () => ({
      name,
      description: "Returns one deterministic fixture.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }),
    async execute() {
      return output;
    },
  };
}
