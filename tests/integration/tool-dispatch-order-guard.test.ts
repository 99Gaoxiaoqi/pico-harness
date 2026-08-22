import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import type { RuntimeEvent } from "../../src/engine/session-runtime-event.js";
import type { RuntimeMessageCommittedEvent } from "../../src/engine/session-runtime-event.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

// ADR 27 决策 4 的守护测试(对抗审查 Finding 2):P0 恢复分类的 F1/F2 判定边界是
// "声明 toolCall 的 message.committed 先于 tool.started 落库"。本测试走真实
// AgentEngine(脚本 provider + 真实注册表 + SQLite 持久化)把该写序钉死在账本序上:
// 任何把派发提前到消息提交之前的重构都会在这里先红。
test("真实引擎账本序:message.committed(toolCall) < tool.started < tool.result.recorded", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-dispatch-order-guard-"));
  const workDir = join(root, "workspace");
  const runtimePort = createEngineRuntimePort();
  const session = new Session("tool-dispatch-order-guard", workDir, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort,
  });
  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the fixture." });
    const registry = new ToolRegistry();
    registry.register(outputTool("order_guard_fixture", "deterministic output"));
    const provider: LLMProvider = {
      async generate() {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call:order-guard", name: "order_guard_fixture", arguments: "{}" }],
        };
      },
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter: new SilentReporter(),
      maxTurns: 2,
    });
    await engine.run(session);

    const events = await session.runtimeEventStore!.readSession(session.id);
    const indexOf = (predicate: (event: RuntimeEvent) => boolean, label: string): number => {
      const index = events.findIndex(predicate);
      assert.ok(index >= 0, `expected ${label} to exist in ledger`);
      return index;
    };
    const declared = indexOf(
      (event): event is RuntimeMessageCommittedEvent =>
        event.kind === "message.committed" &&
        event.data.message.toolCalls?.some((call) => call.id === "call:order-guard") === true,
      "message.committed declaring the tool call",
    );
    const started = indexOf(
      (event) => event.kind === "tool.started" && event.refs?.toolCallId === "call:order-guard",
      "tool.started",
    );
    const recorded = indexOf(
      (event) =>
        event.kind === "tool.result.recorded" && event.refs?.toolCallId === "call:order-guard",
      "tool.result.recorded",
    );
    assert.ok(
      declared < started && started < recorded,
      `ledger order violated: committed@${declared}, started@${started}, recorded@${recorded}`,
    );
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
        additionalProperties: false as const,
      },
    }),
    async execute() {
      return output;
    },
  };
}
