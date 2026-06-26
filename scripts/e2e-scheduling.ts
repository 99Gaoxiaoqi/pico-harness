// E2E: 用真实大模型验证资源冲突图调度(对标 kimi-code ToolScheduler)。
// 运行: node --env-file=.env --import tsx scripts/e2e-scheduling.ts
//
// 验证目标:
//   改造前(二元调度):"写不同文件"整批串行,3 个 write 首尾相接。
//   改造后(冲突图调度):"写不同文件"因路径不冲突而并行,3 个 write 时间重叠。
//
// 方法:
//   1. prompt 明确要求模型"一次性用 write_file 同时创建 3 个不同文件"
//   2. 从 trace JSON 提取所有 Tool.Execute span 的 startTime/endTime
//   3. 判断这些 write 的执行时间区间是否重叠(并行)vs 首尾相接(串行)
//
// 判定标准:
//   - 若 3 个 write 区间两两重叠 → 并行 ✅(冲突图调度生效)
//   - 若 3 个 write 区间互不重叠(一个结束下一个才开始)→ 串行 ❌(退回旧二元行为)

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/engine/loop.js";
import { ToolRegistry, ReadFileTool, WriteFileTool, BashTool } from "../src/tools/registry-impl.js";
import { createRawProvider } from "../src/provider/factory.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { Tracer } from "../src/observability/trace.js";
import { Session } from "../src/engine/session.js";

interface SpanJSON {
  name: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  attributes?: Record<string, unknown>;
  children?: SpanJSON[];
}

/** 从 span 树里递归提取所有 Tool.Execute span */
function collectToolSpans(span: SpanJSON, acc: SpanJSON[] = []): SpanJSON[] {
  if (span.name === "Tool.Execute") {
    acc.push(span);
  }
  for (const child of span.children ?? []) {
    collectToolSpans(child, acc);
  }
  return acc;
}

/** 判断两个时间区间是否重叠 */
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 打印一个甘特图式的时间线,直观展示并行/串行 */
function printTimeline(
  spans: Array<{ name: string; path: string; start: number; end: number }>,
  t0: number,
): void {
  const width = 60;
  const span_total = Math.max(...spans.map((s) => s.end)) - t0;
  console.log("\n  工具执行时间线(每个 | 代表该工具正在执行):");
  console.log("  " + "─".repeat(width));
  for (const s of spans) {
    const startCol = Math.round(((s.start - t0) / span_total) * width);
    const endCol = Math.round(((s.end - t0) / span_total) * width);
    const line = " ".repeat(startCol) + "|".repeat(Math.max(endCol - startCol, 1));
    console.log(`  ${s.path.padEnd(20)} ${line}`);
  }
  console.log("  " + "─".repeat(width));
}

async function main() {
  console.log("=== E2E 资源冲突图调度验证(真实模型)===\n");

  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-sched-"));
  console.log(`[setup] workDir = ${workDir}`);

  const provider = createRawProvider("openai");
  const tracer = new Tracer();

  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new BashTool(workDir));

  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    enableThinking: false,
    reporter: new SilentReporter(),
    tracer,
  });

  // prompt: 明确要求一次性并发写 3 个不同文件(路径不同 → 不冲突 → 应并行)
  const prompt = `请一次性创建以下 3 个文件(在同一条消息里用 3 个 write_file 工具调用,不要分多轮):
1. a.txt - 内容写 "hello from a"
2. b.txt - 内容写 "hello from b"
3. c.txt - 内容写 "hello from c"

必须在同一个响应里发出全部 3 个 write_file 调用。完成后直接回复"done"。`;

  const session = new Session("e2e-sched", workDir);
  session.append({ role: "user", content: prompt });

  console.log("[run] 让模型一次性写 3 个不同文件...\n");
  await engine.run(session);

  // 从 trace 文件提取工具 span 时序
  const traceDir = join(workDir, ".claw", "traces");
  const traceFiles = await readdir(traceDir);
  const latestTrace = traceFiles.sort().at(-1)!;
  const tracePath = join(traceDir, latestTrace);
  const rootSpan = JSON.parse(await readFile(tracePath, "utf8")) as SpanJSON;

  const toolSpans = collectToolSpans(rootSpan);
  const writeSpans = toolSpans
    .filter((s) => s.attributes?.toolName === "write_file")
    .map((s) => ({
      name: s.attributes?.toolName as string,
      path: (s.attributes?.arguments as string | undefined)?.slice(0, 40) ?? "?",
      start: new Date(s.startTime).getTime(),
      end: new Date(s.endTime!).getTime(),
      durationMs: s.durationMs,
    }))
    .sort((a, b) => a.start - b.start);

  console.log(`\n[结果] 共捕获 ${writeSpans.length} 个 write_file 调用:`);
  if (writeSpans.length < 2) {
    console.log("  ⚠️ 捕获到的 write 调用不足 2 个,模型可能没在同一批发出。无法判定调度。");
    return;
  }

  const t0 = Math.min(...writeSpans.map((s) => s.start));
  printTimeline(writeSpans, t0);

  console.log("\n  各 write 精确时序:");
  for (const s of writeSpans) {
    console.log(
      `    ${s.path.padEnd(20)} +${(s.start - t0).toString().padStart(5)}ms ~ +${(s.end - t0).toString().padStart(5)}ms (${s.durationMs}ms)`,
    );
  }

  // 判定:任意两个 write 时间区间是否重叠 → 并行
  let parallelPairs = 0;
  let totalPairs = 0;
  for (let i = 0; i < writeSpans.length; i++) {
    for (let j = i + 1; j < writeSpans.length; j++) {
      totalPairs++;
      if (overlaps(writeSpans[i]!, writeSpans[j]!)) {
        parallelPairs++;
      }
    }
  }

  console.log(`\n  并行判定: ${parallelPairs}/${totalPairs} 对 write 执行区间重叠`);
  if (parallelPairs > 0) {
    console.log("  ✅ 冲突图调度生效 —— 写不同文件被并行执行!");
    console.log("     (旧二元调度会把所有 write 强制串行,区间不会重叠)");
  } else {
    console.log("  ❌ write 全部串行,未观察到并行。可能原因:");
    console.log("     - 模型没有在同一批发出多个 write(检查上面时序间隔)");
    console.log("     - 或调度未生效");
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
