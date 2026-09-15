import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookService as HostHookService } from "@pico/pico-host/hooks/service";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { Session } from "@pico/pico-host/session";
import { HookService, type HookExecutor } from "@pico/pico-host/hooks/service";
import {
  HOOK_EVENTS,
  type HookInput,
  type HookSnapshot,
  type ResolvedHookHandler,
} from "@pico/pico-host/hooks/types";
import type { LLMProvider } from "@pico/core";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import type { BaseTool } from "@pico/pico-host/tool-registry-contract";
import { NO_FILE_SIDE_EFFECTS } from "@pico/pico-host/tool-registry-contract";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";

test("HookService 包入口与旧入口共享 class identity", () => {
  assert.equal(HostHookService, HookService);
});

test("PostToolUse receives one bounded envelope only after canonical commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-result-hook-envelope-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const sessionId = "tool-result-hook-envelope";
  const runtimePort = createEngineRuntimePort();
  const session = new Session(sessionId, workDir, {
    persistence: true,
    picoHome,
    runtimePort,
  });
  try {
    await session.recover();
    await session.commitMessages({ role: "user", content: "Run the large fixture." });

    const canary = "RAW_CANARY_MUST_NOT_ENTER_HOOK_INPUT";
    const rawOutput = buildLargeOutput(canary);
    const registry = new ToolRegistry();
    registry.register(outputTool("large_hook_fixture", rawOutput));

    const inputs: HookInput[] = [];
    let canonicalVisibleDuringHook = false;
    const executor: HookExecutor = {
      async execute(_resolved, input) {
        inputs.push(structuredClone(input));
        const events = await session.runtimeEventStore!.readSession(sessionId);
        canonicalVisibleDuringHook = events.some(
          (event) =>
            event.kind === "tool.result.recorded" &&
            event.refs.toolCallId === "call:large-hook-fixture",
        );
        return { decision: "allow" };
      },
    };
    const hookService = new HookService({
      workDir,
      sessionId,
      executor,
      snapshot: hookSnapshot(["PostToolUse", "PostToolBatch"]),
    });

    let providerTurn = 0;
    const provider: LLMProvider = {
      async generate() {
        providerTurn++;
        if (providerTurn === 1) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call:large-hook-fixture",
                name: "large_hook_fixture",
                arguments: "{}",
              },
            ],
          };
        }
        return { role: "assistant", content: "done" };
      },
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter: new SilentReporter(),
      hookService,
      maxTurns: 3,
    });

    await engine.run(session);

    assert.equal(canonicalVisibleDuringHook, true);
    assert.deepEqual(
      inputs.map((input) => input.hook_event_name),
      ["PostToolUse", "PostToolBatch"],
    );
    const postUse = inputs[0]! as HookInput<"PostToolUse">;
    assert.equal(Object.hasOwn(postUse, "tool_response"), false);
    // ADR 26(E1):大结果全文 inline;envelope 投影受 16KiB 送达上限约束,
    // 中段 canary 超出上限被截断,Hook 输入保持有界。
    assert.equal(JSON.stringify(postUse).includes(canary), false);
    assert.ok(JSON.stringify(postUse).length < 20 * 1024);
    if (postUse.hook_event_name !== "PostToolUse") assert.fail("expected PostToolUse");
    const envelope = postUse.payload.tool_result;
    assert.equal(envelope.toolCallId, "call:large-hook-fixture");
    assert.equal(envelope.toolName, "large_hook_fixture");
    assert.equal(envelope.status, "succeeded");
    assert.equal(envelope.rawSizeBytes, Buffer.byteLength(rawOutput, "utf8"));
    assert.equal(envelope.projection.mode, "full");
    assert.equal(envelope.projection.truncated, false);
    assert.equal(envelope.deliveryTruncated, true);
    assert.equal(envelope.evidence, undefined);

    const batch = inputs[1]! as HookInput<"PostToolBatch">;
    if (batch.hook_event_name !== "PostToolBatch") assert.fail("expected PostToolBatch");
    assert.deepEqual(batch.payload.tools[0]?.tool_result, envelope);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

function hookSnapshot(events: readonly ("PostToolUse" | "PostToolBatch")[]): HookSnapshot {
  const selected = new Set(events);
  const handlers = Object.fromEntries(
    HOOK_EVENTS.map((event) => [
      event,
      selected.has(event as "PostToolUse" | "PostToolBatch") ? [hookHandler(event)] : [],
    ]),
  ) as unknown as HookSnapshot["handlers"];
  return {
    id: "tool-result-envelope",
    version: 1,
    createdAt: new Date(0).toISOString(),
    handlers,
    diagnostics: [],
  };
}

function hookHandler(event: "PostToolUse" | "PostToolBatch"): ResolvedHookHandler;
function hookHandler(event: (typeof HOOK_EVENTS)[number]): ResolvedHookHandler;
function hookHandler(event: (typeof HOOK_EVENTS)[number]): ResolvedHookHandler {
  return {
    id: `fixture:${event}`,
    event,
    source: { kind: "project", path: "/fixture/hooks.json", version: 1 },
    order: 0,
    handler: { type: "command", command: "fixture" },
    trusted: true,
  };
}

function outputTool(name: string, output: string): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => name,
    definition: () => ({
      name,
      description: "Returns a deterministic large ToolResult.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    async execute() {
      return output;
    },
  };
}

function buildLargeOutput(canary: string): string {
  const rows = Array.from(
    { length: 1_500 },
    (_, index) => `ROW-${index.toString().padStart(4, "0")}-UTF8-数据-abcdefghijklmno`,
  );
  rows[Math.floor(rows.length / 2)] = canary;
  return `HEAD_BOUNDARY\n${rows.join("\n")}\nTAIL_BOUNDARY`;
}
