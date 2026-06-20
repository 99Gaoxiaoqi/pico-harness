import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BenchmarkRunner, type BenchmarkAgentRunner } from "../src/eval/benchmark.js";

describe("BenchmarkRunner", () => {
  it("在隔离工作区执行用例并汇总 usage", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tiny-claw-benchmark-"));
    const runAgent: BenchmarkAgentRunner = async (prompt, context) => {
      context.session.recordUsage(100, 25, 0.001);
      const input = await readFile(join(context.workDir, "input.txt"), "utf8");

      await writeFile(join(context.workDir, "answer.txt"), `${input.trim()}:${prompt}`, "utf8");
    };
    const runner = new BenchmarkRunner({
      rootDir,
      now: createClock(0, 25, 25, 75),
      runAgent,
      cases: [
        {
          id: "write-answer",
          name: "写入答案",
          prompt: "finish",
          setupScript: "printf 'seed\\n' > input.txt",
          validateScript: 'test "$(cat answer.txt)" = "seed:finish"',
        },
        {
          id: "boolean-validator",
          name: "布尔验证器",
          prompt: "check",
          setup: async ({ workDir }) => {
            await writeFile(join(workDir, "input.txt"), "ok", "utf8");
          },
          validate: async ({ workDir }) =>
            (await readFile(join(workDir, "answer.txt"), "utf8")) === "ok:check",
        },
      ],
    });

    const result = await runner.run();

    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.passRate).toBe(1);
    expect(result.durationMs).toBe(75);
    expect(result.usage).toEqual({
      promptTokens: 200,
      completionTokens: 50,
      costCNY: 0.002,
    });
    expect(result.cases.map((testCase) => testCase.workDir)).toEqual([
      join(rootDir, "write-answer"),
      join(rootDir, "boolean-validator"),
    ]);
    expect(result.cases.map((testCase) => testCase.durationMs)).toEqual([25, 50]);
  });

  it("记录失败用例并继续执行后续用例", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "tiny-claw-benchmark-"));
    const calls: string[] = [];
    const runner = new BenchmarkRunner({
      rootDir,
      now: createClock(0, 10, 10, 20),
      runAgent: (prompt) => {
        calls.push(prompt);
      },
      cases: [
        {
          id: "bad-case",
          name: "失败用例",
          prompt: "break",
          validateScript: "test -f missing.txt",
        },
        {
          id: "good-case",
          name: "成功用例",
          prompt: "continue",
          validate: () => true,
        },
      ],
    });

    const result = await runner.run();

    expect(calls).toEqual(["break", "continue"]);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.passRate).toBe(0.5);
    expect(result.cases[0]).toMatchObject({
      id: "bad-case",
      passed: false,
    });
    expect(result.cases[0]?.error).toContain("验证脚本执行失败");
    expect(result.cases[1]).toMatchObject({
      id: "good-case",
      passed: true,
    });
  });
});

function createClock(...ticks: readonly number[]): () => number {
  const remaining = [...ticks];

  return () => {
    const next = remaining.shift();

    if (next === undefined) {
      throw new Error("No benchmark clock ticks remaining.");
    }

    return next;
  };
}
