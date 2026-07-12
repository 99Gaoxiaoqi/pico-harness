import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { AgentEngine } from "../src/engine/loop.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";
import { DelegateTaskTool, type AgentRunner } from "../src/tools/subagent.js";

describe("delegation result budget integration", () => {
  it("无 artifact writer 时仍以 5000 字符硬上限熔断", async () => {
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

  it("超过常规目标的完整报告先落盘，主上下文只回灌 2000 字符预览", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-report-"));
    try {
      const longSummary = `结论：根因在 src/engine/loop.ts:100。\n${"E".repeat(
        5_500,
      )}\n风险：尚未执行端到端验证。`;
      const provider: LLMProvider = {
        async generate(): Promise<Message> {
          return { role: "assistant", content: longSummary };
        },
      };
      const store = new ToolResultArtifactStore({
        baseDir: join(workDir, ".claw", "artifacts"),
      });
      const registry = new ToolRegistry();
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        subagentReportArtifactWriter: async (input) => {
          const meta = await store.write({
            sessionId: "summary-budget",
            toolName: "subagent_report",
            args: { taskPrompt: input.taskPrompt, status: input.status },
            output: input.report,
          });
          return meta.path;
        },
      });

      const result = await engine.runSub("返回完整分析", registry);

      expect(result.summary.length).toBeLessThanOrEqual(2_000);
      expect(result.summary).toContain("结论：根因在 src/engine/loop.ts:100");
      expect(result.summary).toContain("风险：尚未执行端到端验证。");
      expect(result.summary).toContain("[完整子代理报告已外部化]");
      expect(result.artifacts).toHaveLength(1);
      expect(await readFile(result.artifacts[0]!, "utf8")).toBe(longSummary);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("required 批量委派在 6k–8k 目标内优先保留失败、partial 和证据", async () => {
    const evidenceArtifacts = [".claw/artifacts/large-result.txt"];
    const runner: AgentRunner = {
      async runSub(taskPrompt) {
        if (taskPrompt === "failed") throw new Error("😀".repeat(3_000));
        if (taskPrompt === "partial") {
          return { status: "partial", summary: "P".repeat(6_000), artifacts: evidenceArtifacts };
        }
        if (taskPrompt === "evidence") {
          return { summary: "A".repeat(6_000), artifacts: evidenceArtifacts };
        }
        return {
          summary: "B".repeat(6_000),
          artifacts: [],
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
        tasks: [{ goal: "plain" }, { goal: "evidence" }, { goal: "partial" }, { goal: "failed" }],
      }),
    );
    const batch = JSON.parse(raw) as {
      results: Array<{
        status: "completed" | "partial" | "error";
        summary?: string;
        error?: string;
        artifacts?: string[];
      }>;
    };
    const textLengths = batch.results.map(
      (result) => (result.summary ?? result.error ?? "").length,
    );

    expect(raw.length).toBeGreaterThanOrEqual(6_000);
    expect(raw.length).toBeLessThanOrEqual(8_000);
    expect(batch.results.map((result) => result.status)).toEqual([
      "completed",
      "completed",
      "partial",
      "error",
    ]);
    expect(textLengths[3]).toBeGreaterThan(textLengths[0]!);
    expect(textLengths[2]).toBeGreaterThan(textLengths[0]!);
    expect(textLengths[1]).toBeGreaterThan(textLengths[0]!);
    expect(batch.results[0]?.summary).toMatch(/^B+/);
    expect(batch.results[1]?.summary).toMatch(/^A+/);
    expect(batch.results[2]?.summary).toMatch(/^P+/);
    expect(batch.results[3]?.error).toMatch(/^😀+/);
    const errorPrefix = batch.results[3]?.error?.split("\n[已截断")[0] ?? "";
    expect(errorPrefix.codePointAt(errorPrefix.length - 2)).toBe(0x1f600);
    expect(
      batch.results.every((result) => (result.summary ?? result.error)?.includes("已截断")),
    ).toBe(true);
    expect(batch.results[1]?.artifacts).toEqual(evidenceArtifacts);
    expect(batch.results[2]?.artifacts).toEqual(evidenceArtifacts);
  });

  it("artifact 路径本身超额时仍硬性遵守 12000 字符总预算", async () => {
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

    expect(raw.length).toBeLessThanOrEqual(12_000);
    expect(batch.results).toHaveLength(4);
    expect(batch.results.every((result) => result.status === "completed")).toBe(true);
    expect(batch.results.every((result) => result.artifacts === undefined)).toBe(true);
    expect(batch.omittedArtifacts).toBe(80);
  });
});
