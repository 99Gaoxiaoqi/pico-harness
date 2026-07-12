import { describe, expect, it } from "vitest";
import { Compactor } from "../src/context/compactor.js";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type {
  BaseTool,
  Registry,
  RequestMiddleware,
  ToolExecutionContext,
} from "../src/tools/registry.js";

describe("subagent compactor isolation integration", () => {
  it("并行 runSub 隔离 stronger compact 状态且保留自定义 Compactor 覆写", async () => {
    const provider = new SiblingBarrierProvider();
    const registry = new EmptyRegistry();
    const compactor = new StrongerStateProbeCompactor();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", compactor });

    const siblingA = engine.runSub("sibling-a", registry, undefined, { maxTurns: 1 });
    await provider.waitUntilSiblingAStarts();

    try {
      await engine.runSub("sibling-b", registry, undefined, { maxTurns: 1 });
    } finally {
      provider.releaseSiblingA();
    }
    await siblingA;

    expect(compactor.customOverrideCalls).toEqual(["sibling-a", "sibling-b"]);
    expect(compactor.probeOutputs.get("sibling-a")).toContain("为了节省内存");
    expect(compactor.probeOutputs.get("sibling-b")).toContain("工具 probe 输出已清理");
    expect(compactor.probeOutputs.get("sibling-b")).not.toContain("为了节省内存");
  });

  it("从子代理异步域唤醒主 Agent 时显式恢复主 Compactor 状态", async () => {
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        return { role: "assistant", content: "main resumed" };
      },
    };
    const registry = new EmptyRegistry();
    const compactor = new MainScopeProbeCompactor();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", compactor });
    const session = new Session("compactor-main-scope", "/tmp", { persistence: false });
    session.append({ role: "user", content: "main-run-probe" });

    try {
      await compactor.runSeededIsolatedScope(() => engine.run(session));
      expect(compactor.mainProbeOutput).toContain("工具 probe 输出已清理");
      expect(compactor.mainProbeOutput).not.toContain("为了节省内存");
    } finally {
      await session.close();
    }
  });
});

class StrongerStateProbeCompactor extends Compactor {
  readonly customOverrideCalls: string[] = [];
  readonly probeOutputs = new Map<string, string>();

  constructor() {
    super({ maxChars: 200, retainLastMsgs: 0 });
  }

  override compactToBudget(messages: Message[], _maxChars?: number): Message[] {
    const sibling = messages[1]?.content.includes("sibling-a")
      ? "sibling-a"
      : messages[1]?.content.includes("sibling-b")
        ? "sibling-b"
        : undefined;
    if (!sibling) return structuredClone(messages);

    this.customOverrideCalls.push(sibling);
    if (sibling === "sibling-a") {
      super.compactToBudget(makeStrongerCompactTrace(), 180);
    }
    const probe = super.compact(makeRemoteToolTrace());
    this.probeOutputs.set(sibling, probe.find((message) => message.toolCallId)?.content ?? "");
    return structuredClone(messages);
  }
}

class SiblingBarrierProvider implements LLMProvider {
  private readonly siblingAStarted: Promise<void>;
  private resolveSiblingAStarted!: () => void;
  private readonly siblingAReleased: Promise<void>;
  private resolveSiblingAReleased!: () => void;

  constructor() {
    this.siblingAStarted = new Promise((resolve) => {
      this.resolveSiblingAStarted = resolve;
    });
    this.siblingAReleased = new Promise((resolve) => {
      this.resolveSiblingAReleased = resolve;
    });
  }

  waitUntilSiblingAStarts(): Promise<void> {
    return this.siblingAStarted;
  }

  releaseSiblingA(): void {
    this.resolveSiblingAReleased();
  }

  async generate(messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    const task = messages[1]?.content ?? "";
    if (task.includes("sibling-a")) {
      this.resolveSiblingAStarted();
      await this.siblingAReleased;
    }
    return { role: "assistant", content: `summary:${task.includes("sibling-a") ? "a" : "b"}` };
  }
}

class MainScopeProbeCompactor extends Compactor {
  mainProbeOutput = "";

  constructor() {
    super({ maxChars: 200, retainLastMsgs: 0 });
  }

  runSeededIsolatedScope<T>(callback: () => T): T {
    return this.runInIsolatedScope(() => {
      super.compactToBudget(makeStrongerCompactTrace(), 180);
      return callback();
    });
  }

  override compactToBudget(messages: Message[], maxChars?: number): Message[] {
    if (messages.some((message) => message.content.includes("main-run-probe"))) {
      const probe = super.compact(makeRemoteToolTrace());
      this.mainProbeOutput = probe.find((message) => message.toolCallId)?.content ?? "";
      return structuredClone(messages);
    }
    return super.compactToBudget(messages, maxChars);
  }
}

class EmptyRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(_middleware: RequestMiddleware): void {}
  getAvailableTools(): ToolDefinition[] {
    return [];
  }
  async execute(_call: ToolCall, _context?: ToolExecutionContext): Promise<ToolResult> {
    throw new Error("empty registry must not execute tools");
  }
}

function makeStrongerCompactTrace(): Message[] {
  return [
    { role: "user", content: "u".repeat(300) },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "stronger", name: "probe", arguments: "{}" }],
    },
    { role: "user", toolCallId: "stronger", content: "x".repeat(1_000) },
  ];
}

function makeRemoteToolTrace(): Message[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "remote", name: "probe", arguments: "{}" }],
    },
    { role: "user", toolCallId: "remote", content: "x".repeat(1_000) },
  ];
}
