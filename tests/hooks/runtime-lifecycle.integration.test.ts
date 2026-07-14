import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalSessionManager, Session } from "../../src/engine/session.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { HookService } from "../../src/hooks/service.js";
import {
  HOOK_EVENTS,
  type HookEvent,
  type HookInput,
  type HookOutput,
  type HookSnapshot,
  type ResolvedHookHandler,
} from "../../src/hooks/types.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { Message } from "../../src/schema/message.js";
import type { BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

function snapshot(events: readonly HookEvent[]): HookSnapshot {
  const handlers = Object.fromEntries(HOOK_EVENTS.map((event) => [event, []])) as Record<
    HookEvent,
    ResolvedHookHandler[]
  >;
  for (const [order, event] of events.entries()) {
    handlers[event].push({
      id: event,
      event,
      source: { kind: "local", path: ".claw/hooks.local.json", version: 1 },
      order,
      handler: { type: "command", command: `capture-${event}` },
      trusted: true,
    });
  }
  return {
    id: "runtime-lifecycle",
    version: 1,
    createdAt: new Date().toISOString(),
    handlers,
    diagnostics: [],
  };
}

function service(
  workDir: string,
  events: readonly HookEvent[],
  execute: (input: HookInput) => HookOutput | Promise<HookOutput>,
): HookService {
  return new HookService({
    workDir,
    sessionId: "hook-runtime-test",
    snapshot: snapshot(events),
    executor: { execute: async (_entry, input) => execute(input) },
  });
}

class OneShotProvider implements LLMProvider {
  readonly messages: Message[][] = [];

  async generate(messages: Message[]): Promise<Message> {
    this.messages.push(messages.map((message) => ({ ...message })));
    return { role: "assistant", content: "done" };
  }
}

class CaptureTool implements BaseTool {
  readonly seen: string[] = [];
  name(): string {
    return "capture";
  }
  definition() {
    return {
      name: "capture",
      description: "capture input",
      inputSchema: { type: "object" as const, properties: {} },
    };
  }
  async execute(args: string): Promise<string> {
    this.seen.push(args);
    return "tool-ok";
  }
}

describe("Hook runtime lifecycle integration", () => {
  afterEach(() => {
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("UserPrompt 在 Session commit 前改写，并按会话顺序发送 start/instructions/stop/end", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-hook-runtime-"));
    const seen: HookEvent[] = [];
    const hooks = service(
      workDir,
      [
        "SessionStart",
        "UserPromptSubmit",
        "UserPromptExpansion",
        "InstructionsLoaded",
        "MessageDisplay",
        "Stop",
        "SessionEnd",
      ],
      (input) => {
        seen.push(input.hook_event_name);
        return input.hook_event_name === "UserPromptSubmit"
          ? { decision: "allow", modifiedInput: "rewritten prompt" }
          : { decision: "allow" };
      },
    );
    const provider = new OneShotProvider();

    await new AgentRuntime().execute(
      { prompt: "original prompt", dir: workDir, session: "hook-runtime-test" },
      { provider, reporter: new SilentReporter(), hookService: hooks },
    );

    expect(provider.messages[0]?.some((message) => message.content === "rewritten prompt")).toBe(
      true,
    );
    expect(seen).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "InstructionsLoaded",
      "MessageDisplay",
      "Stop",
      "SessionEnd",
    ]);
  });

  it("工具调用严格按 safety -> PreToolUse -> permission -> execute -> PostToolUse 执行", async () => {
    const order: string[] = [];
    const hooks = service("/tmp", ["PreToolUse", "PostToolUse"], (input) => {
      order.push(input.hook_event_name);
      return input.hook_event_name === "PreToolUse"
        ? { decision: "allow", modifiedInput: { value: "rewritten" } }
        : { decision: "allow" };
    });
    const registry = new ToolRegistry({ truncateResults: false });
    const tool = new CaptureTool();
    registry.register(tool);
    registry.setHookService(hooks);
    registry.useSafety(async (call) => {
      order.push(`safety:${JSON.parse(call.arguments).value as string}`);
      return { allowed: true };
    });
    registry.usePermission(async (call) => {
      order.push(`permission:${JSON.parse(call.arguments).value as string}`);
      return { allowed: true };
    });

    await expect(
      registry.execute({
        id: "call-1",
        name: "capture",
        arguments: JSON.stringify({ value: "original" }),
      }),
    ).resolves.toMatchObject({ output: "tool-ok", isError: false });

    expect(order).toEqual([
      "safety:original",
      "PreToolUse",
      "safety:rewritten",
      "permission:rewritten",
      "PostToolUse",
    ]);
    expect(tool.seen).toEqual([JSON.stringify({ value: "rewritten" })]);
  });

  it("Stop hook 连续阻断最多续跑 3 次", async () => {
    let stopCalls = 0;
    const hooks = service("/tmp", ["Stop"], () => {
      stopCalls++;
      return { decision: "deny", reason: "continue" };
    });
    const responses: Message[] = [
      { role: "assistant", content: "stop-1" },
      { role: "assistant", content: "stop-2" },
      { role: "assistant", content: "stop-3" },
      { role: "assistant", content: "stop-4" },
    ];
    const provider: LLMProvider = {
      async generate() {
        const next = responses.shift();
        if (!next) throw new Error("unexpected fifth turn");
        return next;
      },
    };
    const session = new Session("stop-hook-limit", "/tmp", { persistence: false });
    session.append({ role: "user", content: "work" });
    const engine = new AgentEngine({
      provider,
      registry: new ToolRegistry(),
      workDir: "/tmp",
      hookService: hooks,
    });

    await engine.run(session);

    expect(stopCalls).toBe(4);
    expect(
      session
        .getHistory()
        .filter((message) => message.providerData?.["picoKind"] === "continuation"),
    ).toHaveLength(3);
  });

  it("FileChanged 只在文件事务确认真实变化后发送", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-hook-file-change-"));
    const target = join(workDir, "changed.txt");
    const changedPaths: string[][] = [];
    const hooks = service(workDir, ["FileChanged"], (input) => {
      if (input.hook_event_name === "FileChanged") {
        changedPaths.push([...input.payload.paths]);
      }
      return { decision: "allow" };
    });
    const registry = new ToolRegistry();
    registry.setHookService(hooks);
    registry.register({
      name: () => "write_exact",
      definition: () => ({
        name: "write_exact",
        description: "write exact file",
        inputSchema: { type: "object", properties: {} },
      }),
      fileSideEffects: (args) => ({
        kind: "exact",
        paths: [String((JSON.parse(args) as { path: string }).path)],
      }),
      async execute(args) {
        const input = JSON.parse(args) as { path: string; content: string };
        await writeFile(join(workDir, input.path), input.content, "utf8");
        return "written";
      },
    });
    const responses: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-1",
            name: "write_exact",
            arguments: JSON.stringify({ path: "changed.txt", content: "new" }),
          },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const provider: LLMProvider = {
      async generate() {
        const next = responses.shift();
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
    const session = new Session("file-change-hook", workDir, { persistence: false });
    session.append({ role: "user", content: "write" });

    await new AgentEngine({ provider, registry, workDir, hookService: hooks }).run(session);

    expect(changedPaths).toEqual([[target]]);
  });
});
