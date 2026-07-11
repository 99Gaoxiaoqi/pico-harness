import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";
import { DelegateTaskTool, type AgentRunner } from "../src/tools/subagent.js";

describe("delegation result budget integration", () => {
  it("子代理最终 summary 限制为 5000 字符并显式标记截断", async () => {
    const longSummary = "S".repeat(6_000);
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        return { role: "assistant", content: longSummary };
      },
    };
    const registry = new ToolRegistry();
    const engine = new AgentEngine({ provider, registry, workDir: tmpdir() });

    const result = await engine.runSub("返回长总结", registry);

    expect(result.summary).toHaveLength(5_000);
    expect(result.summary).toContain("[子代理总结已截断：原始 6000 字符，上限 5000 字符]");
  });

  it("required 批量委派公平压缩到 10000 字符并保留结构化结果", async () => {
    const artifacts = [".claw/artifacts/large-result.txt"];
    const runner: AgentRunner = {
      async runSub(taskPrompt) {
        if (taskPrompt === "short") return { summary: "s".repeat(100), artifacts };
        if (taskPrompt === "failed") throw new Error("E".repeat(6_000));
        return {
          summary: taskPrompt === "long-a" ? "A".repeat(6_000) : "B".repeat(6_000),
          artifacts,
        };
      },
    };
    const tool = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager({ maxConcurrentChildren: 4 }),
    );

    const raw = await tool.execute(
      JSON.stringify({
        tasks: [{ goal: "short" }, { goal: "long-a" }, { goal: "failed" }, { goal: "long-b" }],
      }),
    );
    const batch = JSON.parse(raw) as {
      results: Array<{
        status: "completed" | "error";
        summary?: string;
        error?: string;
        artifacts?: string[];
      }>;
    };
    const textLengths = batch.results.map(
      (result) => (result.summary ?? result.error ?? "").length,
    );

    expect(raw.length).toBeLessThanOrEqual(10_000);
    expect(textLengths[0]).toBe(100);
    expect(
      Math.max(...textLengths.slice(1)) - Math.min(...textLengths.slice(1)),
    ).toBeLessThanOrEqual(1);
    expect(batch.results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
      "error",
      "completed",
    ]);
    expect(batch.results[1]?.summary).toMatch(/^A+/);
    expect(batch.results[2]?.error).toMatch(/^E+/);
    expect(batch.results[3]?.summary).toMatch(/^B+/);
    expect(
      batch.results
        .slice(1)
        .every((result) => (result.summary ?? result.error)?.includes("已截断")),
    ).toBe(true);
    expect(batch.results[0]?.artifacts).toEqual(artifacts);
    expect(batch.results[1]?.artifacts).toEqual(artifacts);
    expect(batch.results[3]?.artifacts).toEqual(artifacts);
  });

  it("artifact 路径本身超额时仍硬性遵守 10000 字符总预算", async () => {
    const oversizedArtifacts = Array.from(
      { length: 20 },
      (_, index) => `.claw/artifacts/${index}-${"p".repeat(800)}.txt`,
    );
    const runner: AgentRunner = {
      async runSub() {
        return { summary: "done", artifacts: oversizedArtifacts };
      },
    };
    const tool = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager({ maxConcurrentChildren: 4 }),
    );

    const raw = await tool.execute(
      JSON.stringify({
        tasks: Array.from({ length: 4 }, (_, index) => ({ goal: `task-${index}` })),
      }),
    );
    const batch = JSON.parse(raw) as {
      results: Array<{ status: string; summary?: string; artifacts?: string[] }>;
      omittedArtifacts?: number;
    };

    expect(raw.length).toBeLessThanOrEqual(10_000);
    expect(batch.results).toHaveLength(4);
    expect(batch.results.every((result) => result.status === "completed")).toBe(true);
    expect(batch.results.every((result) => result.artifacts === undefined)).toBe(true);
    expect(batch.omittedArtifacts).toBe(80);
  });
});
