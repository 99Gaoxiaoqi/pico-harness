// E2E: 用真实大模型验证「多个子代理并行委派」全链路。
// 运行: node --env-file=.env --import tsx scripts/e2e-multi-subagent.ts
//
// 验证点(全部用真实模型 deepseek-v4-pro,并发拉起多个隔离子智能体):
//   A. 并发委派:DelegateTaskTool + runBatch(mapLimit) 同时拉起多个子代理,
//      各子代理拿到独立纯净上下文,互不串扰,全部返回有效 summary
//   B. 跨平台 bash:子代理用 bash 工具执行 POSIX 命令(pwd/printf/管道),
//      验证 Git Bash 统一 shell 在真实链路下生效(本次跨平台修复的核心)
//   C. worker 写文件:worker 模式子代理用 write_file 受控产出文件,
//      验证 explore/worker 工具集分流 + 物理隔离边界
//   D. summary 质量:每个子代理 summary 均 >= 200 字(扩写机制)
//   E. artifact 外部化:读大文件的子代理回传 artifact 路径

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/engine/loop.js";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { createToolResultObservationProcessor } from "../src/tools/tool-result-observation.js";
import { ToolRegistry, ReadFileTool, BashTool } from "../src/tools/registry-impl.js";
import { createRawProvider } from "../src/provider/factory.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { DelegateTaskTool } from "../src/tools/subagent.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { resolveShell, isWindows } from "../src/os/shell.js";

async function main() {
  console.log("=== E2E 多子代理并行委派集成测试(真实大模型) ===");
  console.log(`[setup] 平台: ${process.platform}, 解析到的 shell: ${resolveShell()}\n`);

  // 1. 隔离工作区 + 预置测试物料
  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-multi-"));
  console.log(`[setup] workDir = ${workDir}`);

  // 物料 1:给 explore 子代理探查的源码文件
  await writeFile(
    join(workDir, "calculator.js"),
    [
      "export function add(a, b) { return a + b; }",
      "export function sub(a, b) { return a - b; }",
      "export function mul(a, b) { return a * b; }",
      "// BUG: 除零未处理",
      "export function div(a, b) { return a / b; }",
      "",
    ].join("\n"),
    "utf8",
  );

  // 物料 2:给 explore 子代理探查的大文件(触发 artifact 外部化,>4000 字)
  const bigLog = "[LOG] 2026-06-26 系统运行正常,服务节点心跳上报中。\n".repeat(200);
  await writeFile(join(workDir, "server.log"), bigLog, "utf8");
  console.log(`[setup] 预置 calculator.js + server.log(${bigLog.length} 字)\n`);

  // 2. 装配真实 provider + 引擎 + 委派基础设施
  const provider = createRawProvider("openai");
  const observationProcessor = createToolResultObservationProcessor({
    store: new ToolResultArtifactStore({ baseDir: join(workDir, ".claw", "artifacts") }),
  });

  const mainRegistry = new ToolRegistry({ truncateResults: false });
  mainRegistry.register(new ReadFileTool(workDir));
  mainRegistry.register(new BashTool(workDir));

  const manager = new DelegationManager({ maxConcurrentChildren: 3 });

  const engine = new AgentEngine({
    provider,
    registry: mainRegistry,
    workDir,
    enableThinking: false,
    observationProcessor,
    reporter: new SilentReporter(),
  });

  // registryFactory:explore=只读+只读bash, worker=可写
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    runner: engine,
    manager,
    maxSpawnDepth: 2,
  });

  // delegate_task 工具(主 Agent 不直接出现,我们直接调 execute 模拟批量委派)
  const delegateTool = new DelegateTaskTool(engine, registryFactory, manager, {
    depth: 0,
    maxSpawnDepth: 2,
    role: "orchestrator",
  });

  // 3. 构造一批互不依赖的子任务(混合 explore/worker,覆盖各验证点)
  const batchStartedAt = Date.now();
  console.log("[step] 并发委派 4 个子任务(mapLimit 上限 3)...\n");

  const raw = await delegateTool.execute(
    JSON.stringify({
      tasks: [
        {
          goal: "用 bash 工具执行 `pwd` 然后执行 `printf 'x\\ny\\nz\\n' | grep y`,报告两次命令的输出结果。这能验证跨平台 shell 行为。",
          mode: "explore",
        },
        {
          goal: "用 read_file 读取 calculator.js,找出其中的 BUG(除零未处理),并说明如何修复。简要总结。",
          mode: "explore",
        },
        {
          goal: "用 read_file 读取 server.log,了解日志的总体规模(行数/字节数)和内容模式。简要总结。",
          mode: "explore",
        },
        {
          goal: "创建一个新文件 fix.txt,内容写一句话:'除零 bug 已记录,待修复'。完成后报告文件是否创建成功。",
          mode: "worker",
        },
      ],
    }),
  );

  const elapsed = Date.now() - batchStartedAt;
  const batch = JSON.parse(raw) as {
    results: Array<{
      taskIndex: number;
      status: "completed" | "error";
      summary?: string;
      artifacts?: string[];
      error?: string;
      durationMs: number;
    }>;
    totalDurationMs: number;
    error?: string;
  };

  console.log(`[step] 批量委派完成,墙钟耗时 ${elapsed}ms(并发执行应远小于各任务耗时之和)\n`);

  if (batch.error) {
    console.log(`❌ 批量委派整体报错: ${batch.error}`);
    process.exit(1);
  }

  // 4. 逐个打印子任务结果
  console.log("========== 各子代理结果 ==========");
  for (const r of batch.results) {
    console.log(`\n--- 子任务 #${r.taskIndex} [${r.status}] 耗时 ${r.durationMs}ms ---`);
    if (r.error) {
      console.log(`  错误: ${r.error}`);
      continue;
    }
    console.log(`  summary(${r.summary?.length ?? 0} 字): ${(r.summary ?? "").slice(0, 300)}`);
    if (r.artifacts && r.artifacts.length > 0) {
      console.log(`  artifacts: ${r.artifacts}`);
    }
  }

  // 5. 验证断言
  console.log("\n========== 验证 ==========");
  const results = batch.results;
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`[${ok ? "✅" : "❌"}] ${name}${detail ? " — " + detail : ""}`);
    if (ok) {
      pass++;
    } else {
      fail++;
    }
  };

  // 验证 A:并发委派——4 个任务全部完成,无 error
  const allCompleted = results.length === 4 && results.every((r) => r.status === "completed");
  check(
    "验证 A 并发委派:4 个子任务全部 completed",
    allCompleted,
    `实际 ${results.length} 个, ${results.filter((r) => r.status === "error").length} 个 error`,
  );

  // 验证 A2:并发确实生效(墙钟 < 各任务耗时之和,说明 mapLimit 并行了)
  const sumDurations = results.reduce((s, r) => s + r.durationMs, 0);
  const concurrencyEffective = batch.totalDurationMs < sumDurations * 0.85;
  check(
    "验证 A2 并发生效:总耗时 < 单任务耗时之和 ×0.85",
    concurrencyEffective,
    `总 ${batch.totalDurationMs}ms vs 串行 ${sumDurations}ms`,
  );

  // 验证 B:跨平台 bash——子任务 #0 的 summary 应含 pwd 输出和 grep 结果 "y"
  const bashTask = results.find((r) => r.taskIndex === 0);
  const bashSummary = bashTask?.summary ?? "";
  const bashOk =
    bashSummary.length > 0 &&
    (bashSummary.includes("y") || /y\b/.test(bashSummary)) &&
    (bashSummary.includes(workDir) || bashSummary.includes("pico-e2e-multi"));
  check(
    "验证 B 跨平台 bash:子代理 #0 用 Git Bash 跑通 pwd + 管道 grep",
    bashOk,
    `summary 含 'y' 和工作区路径`,
  );

  // 验证 C:worker 写文件——子任务 #3 应已创建 fix.txt
  const fixPath = join(workDir, "fix.txt");
  let workerOk = false;
  let workerDetail: string;
  if (existsSync(fixPath)) {
    const content = await readFile(fixPath, "utf8");
    workerOk = content.includes("bug") || content.includes("除零") || content.length > 0;
    workerDetail = `fix.txt 内容: "${content.slice(0, 60)}"`;
  } else {
    workerDetail = "fix.txt 未创建";
  }
  check("验证 C worker 写文件:子代理 #3 受控创建 fix.txt", workerOk, workerDetail);

  // 验证 D:summary 质量——每个 completed 子代理 summary >= 200 字
  const shortSummaries = results.filter(
    (r) => r.status === "completed" && (r.summary?.length ?? 0) < 200,
  );
  check(
    "验证 D summary 扩写:所有 completed 子代理 summary >= 200 字",
    shortSummaries.length === 0,
    shortSummaries.length === 0
      ? ""
      : `${shortSummaries.length} 个过短: ${shortSummaries.map((r) => `#${r.taskIndex}=${r.summary?.length}字`).join(", ")}`,
  );

  // 验证 E:artifact 外部化——读 server.log(大文件)的子代理 #2 应回传 artifact
  const bigFileTask = results.find((r) => r.taskIndex === 2);
  const artifactOk = (bigFileTask?.artifacts?.length ?? 0) > 0;
  check(
    "验证 E artifact 外部化:子代理 #2 读大文件回传 artifact 路径",
    artifactOk,
    artifactOk ? `路径: ${bigFileTask!.artifacts![0]}` : "未触发外部化(可能模型未读全或未超阈值)",
  );

  // 验证 E2:artifact 路径用正斜杠(pathe 修复的体现,仅 Windows 上校验)
  if (artifactOk && isWindows) {
    const ap = bigFileTask!.artifacts![0]!;
    const forwardSlash = ap.includes("/") && !ap.includes("\\");
    check("验证 E2 artifact 路径正斜杠化(pathe)", forwardSlash, `路径: ${ap}`);
  } else if (!isWindows) {
    console.log("[ℹ️] 验证 E2 跳过:非 Windows 平台,路径本就是正斜杠");
  }

  // 6. 收尾
  console.log(`\n========== 汇总 ==========`);
  console.log(`通过 ${pass} / 失败 ${fail}`);
  console.log(`\n=== E2E 完成 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
