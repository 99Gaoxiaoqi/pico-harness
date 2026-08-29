import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

test("AgentEngine still rejects a live same-Session re-entrant run", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-agent-engine-live-reentry-"));
  const session = new Session("agent-engine-live-reentry", workDir, { persistence: false });
  let providerCalls = 0;
  const provider: LLMProvider = {
    generate: async () => {
      providerCalls++;
      await assert.rejects(engine.run(session), /AgentEngine does not support re-entrant runs/u);
      return { role: "assistant", content: "outer run complete" };
    },
  };
  const engine = new AgentEngine({
    provider,
    registry: new ToolRegistry(),
    workDir,
    maxTurns: 1,
  });
  try {
    await session.commitMessages({ role: "user", content: "exercise live re-entry guard" });
    await engine.run(session);
    assert.equal(providerCalls, 1);
  } finally {
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test("AgentEngine ends the Run after a host-declared terminal tool succeeds", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-agent-engine-terminal-tool-"));
  const session = new Session("agent-engine-terminal-tool", workDir, { persistence: false });
  const registry = new ToolRegistry();
  registry.register({
    readOnly: false,
    name: () => "yield_agent_graph",
    definition: () => ({
      name: "yield_agent_graph",
      description: "fixture terminal tool",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    execute: async () => JSON.stringify({ permitId: "permit-1" }),
  });
  let providerCalls = 0;
  const engine = new AgentEngine({
    provider: {
      generate: async () => {
        providerCalls++;
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "yield-1", name: "yield_agent_graph", arguments: "{}" }],
        };
      },
    },
    registry,
    workDir,
    stopAfterSuccessfulToolNames: ["yield_agent_graph"],
  });
  try {
    await session.commitMessages({ role: "user", content: "yield once" });
    const history = await engine.run(session);
    assert.equal(providerCalls, 1);
    assert.equal(history.filter((message) => message.toolCallId === "yield-1").length, 1);
  } finally {
    await session.close();
    await rm(workDir, { recursive: true, force: true });
  }
});
