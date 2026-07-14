import { describe, expect, it } from "vitest";
import { HookService, aggregateHookOutputs } from "../../src/hooks/service.js";
import { HOOK_EVENTS, type HookSnapshot, type ResolvedHookHandler } from "../../src/hooks/types.js";

function snapshot(entries: readonly ResolvedHookHandler[]): HookSnapshot {
  const handlers = Object.fromEntries(HOOK_EVENTS.map((event) => [event, []])) as Record<
    (typeof HOOK_EVENTS)[number],
    ResolvedHookHandler[]
  >;
  for (const entry of entries) handlers[entry.event].push(entry);
  return {
    id: "test",
    version: 1,
    createdAt: new Date().toISOString(),
    handlers,
    diagnostics: [],
  };
}

function command(id: string, order: number): ResolvedHookHandler {
  return {
    id,
    event: "PreToolUse",
    source: { kind: "local", path: ".claw/hooks.local.json", version: 1 },
    order,
    matcher: "bash",
    handler: { type: "command", command: `check-${id}` },
    trusted: true,
  };
}

function agent(id: string, order: number): ResolvedHookHandler {
  return {
    ...command(id, order),
    handler: { type: "agent", prompt: id },
  };
}

describe("HookService integration", () => {
  it("并行执行命中 handler，并按配置顺序聚合上下文与最高优先级决策", async () => {
    const started: string[] = [];
    const service = new HookService({
      workDir: "/workspace",
      sessionId: "session-1",
      snapshot: snapshot([command("first", 0), command("second", 1)]),
      executor: {
        async execute(entry) {
          started.push(entry.id);
          if (entry.id === "first") {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { decision: "allow", additionalContext: "first" };
          }
          return { decision: "deny", reason: "blocked", additionalContext: "second" };
        },
      },
    });

    const result = await service.dispatch("PreToolUse", {
      tool_name: "bash",
      tool_input: { command: "rm -rf /tmp/data" },
    });

    expect(started).toEqual(["first", "second"]);
    expect(result).toMatchObject({
      decision: "deny",
      reason: "blocked",
      additionalContext: "first\nsecond",
    });
  });

  it("事件执行期间保持旧快照，下一次 dispatch 才使用热重载快照", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = command("old", 0);
    const service = new HookService({
      workDir: "/workspace",
      sessionId: "session-1",
      snapshot: snapshot([first]),
      executor: {
        async execute(entry) {
          if (entry.id === "old") await gate;
          return { decision: "deny", reason: entry.id };
        },
      },
    });

    const inFlight = service.dispatch("PreToolUse", { tool_name: "bash", tool_input: {} });
    service.replaceSnapshot(snapshot([command("new", 0)]));
    release();

    await expect(inFlight).resolves.toMatchObject({ reason: "old" });
    await expect(
      service.dispatch("PreToolUse", { tool_name: "bash", tool_input: {} }),
    ).resolves.toMatchObject({ reason: "new" });
  });

  it("deny > defer > ask > allow，改写值取配置顺序首个", () => {
    expect(
      aggregateHookOutputs([
        { decision: "ask", modifiedInput: { value: 1 } },
        { decision: "deny", reason: "deny", modifiedInput: { value: 2 } },
        { decision: "defer", reason: "defer" },
      ]),
    ).toMatchObject({ decision: "deny", reason: "deny", modifiedInput: { value: 1 } });
  });

  it("agent handler 使用独立并发上限，普通 executor 异常 fail-open", async () => {
    let active = 0;
    let peak = 0;
    const service = new HookService({
      workDir: "/workspace",
      sessionId: "session-1",
      snapshot: snapshot(
        Array.from({ length: 20 }, (_, index) => agent(`agent-${String(index)}`, index)),
      ),
      agentConcurrency: 2,
      executor: {
        async execute(entry) {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          if (entry.id === "agent-19") throw new Error("broken verifier");
          return { decision: "allow" };
        },
      },
    });

    const result = await service.dispatch("PreToolUse", { tool_name: "bash", tool_input: {} });

    expect(peak).toBe(2);
    expect(result.decision).toBe("allow");
    expect(result.diagnostics?.[0]?.message).toContain("broken verifier");
  });

  it("父 AbortSignal 取消不是 fail-open", async () => {
    const controller = new AbortController();
    const service = new HookService({
      workDir: "/workspace",
      sessionId: "session-1",
      snapshot: snapshot([command("slow", 0)]),
      executor: {
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw controller.signal.reason;
        },
      },
    });
    controller.abort(new Error("parent cancelled"));

    await expect(
      service.dispatch(
        "PreToolUse",
        { tool_name: "bash", tool_input: {} },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("parent cancelled");
  });
});
