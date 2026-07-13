import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: readonly Message[]; tools: readonly ToolDefinition[] }> = [];

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    const next = this.responses.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

describe("AgentRuntime integration", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("runs through a non-TUI host and emits lifecycle events", async () => {
    const runtime = new AgentRuntime();
    const provider = new ScriptedProvider([
      { role: "assistant", content: "runtime completed", usage: { promptTokens: 1, completionTokens: 1 } },
    ]);
    const events: string[] = [];

    const result = await runtime.execute(
      { prompt: "say done", dir: await mkdtemp(join(tmpdir(), "pico-runtime-success-")) },
      {
        provider,
        reporter: new SilentReporter(),
        onEvent: (event) => events.push(event.type),
      },
    );

    expect(result.finalMessage).toBe("runtime completed");
    expect(events).toEqual(["run.started", "run.finished"]);
  });

  it("fails closed when a dangerous tool has no approval host", async () => {
    const runtime = new AgentRuntime();
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "dangerous-bash", name: "bash", arguments: JSON.stringify({ command: "echo blocked" }) },
        ],
      },
      { role: "assistant", content: "approval was denied" },
    ]);

    const result = await runtime.execute(
      { prompt: "run a command", dir: await mkdtemp(join(tmpdir(), "pico-runtime-deny-")) },
      { provider, reporter: new SilentReporter() },
    );

    expect(result.finalMessage).toBe("approval was denied");
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain("blocked");
  });
});
