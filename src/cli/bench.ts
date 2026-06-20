// Benchmark 入口:第 20 讲自动化评估流水线。
// 用法:
//   tsx --env-file=.env src/cli/bench.ts
//   npm run bench

import { join } from "node:path";
import { parseArgs } from "node:util";
import { BenchmarkRunner, type BenchmarkAgentRunner, type BenchmarkCase } from "../eval/index.js";
import { AgentEngine } from "../engine/loop.js";
import { SilentReporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { CostTracker } from "../observability/tracker.js";
import { Tracer } from "../observability/trace.js";
import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "../tools/registry-impl.js";

function buildRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new BashTool(workDir));
  registry.register(new EditFileTool(workDir));
  return registry;
}

function buildCompactor(): Compactor {
  return new Compactor({ maxChars: 20000, retainLastMsgs: 6 });
}

function buildAgentRunner(kind: ProviderKind): BenchmarkAgentRunner {
  return async (prompt, context) => {
    const provider = createProvider(kind);
    const trackedProvider = new CostTracker(
      provider,
      kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet",
      context.session,
    );
    const registry = buildRegistry(context.workDir);
    const engine = new AgentEngine({
      provider: trackedProvider,
      registry,
      workDir: context.workDir,
      enableThinking: false,
      planMode: false,
      compactor: buildCompactor(),
      reporter: new SilentReporter(),
      tracer: new Tracer(),
    });

    context.session.append({ role: "user", content: prompt });
    await engine.run(context.session);
  };
}

const DEFAULT_CASES: BenchmarkCase[] = [
  {
    id: "test_001_edit",
    name: "测试模糊替换工具的准确性",
    setupScript: `printf '{"name": "tiny-claw", "version": "v1.0.0"}\\n' > config.json`,
    prompt:
      "当前目录下有一个 config.json。请你使用 edit_file 工具，将其中的 version 从 v1.0.0 修改为 v2.0.0。",
    validateScript: `grep '"version": "v2.0.0"' config.json`,
  },
  {
    id: "test_002_code_gen",
    name: "测试代码阅读与创建新文件的综合能力",
    setupScript: `printf 'package math\\n\\nfunc Multiply(a, b int) int {\\n\\treturn a * b\\n}\\n' > math.go`,
    prompt:
      "当前目录下有一个 math.go。请你仔细阅读它，然后在同级目录下，帮我写一个规范的单元测试文件 math_test.go，用来测试 Multiply 函数。请务必包含正常的测试用例。",
    validateScript: `go mod init bench >/dev/null 2>&1 && go test -v ./...`,
  },
];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      root: { type: "string", default: "workspace/bench" },
    },
  });
  const kind = values.provider as ProviderKind;
  const rootDir = join(process.cwd(), values.root);
  const runner = new BenchmarkRunner({
    rootDir,
    cases: DEFAULT_CASES,
    runAgent: buildAgentRunner(kind),
  });

  console.log("==================================================");
  console.log(`🚀 启动自动化 Harness Benchmark 评估 | Provider: ${kind}`);
  console.log(`评测工作区: ${rootDir}`);
  console.log("==================================================");

  const result = await runner.run();
  for (const testCase of result.cases) {
    const status = testCase.passed ? "✅" : "❌";
    const detail = testCase.error ?? testCase.message ?? "";
    console.log(
      `${status} [${testCase.id}] ${testCase.name} | 耗时: ${testCase.durationMs}ms | 花费: ¥${testCase.usage.costCNY.toFixed(6)}${detail ? ` | ${detail}` : ""}`,
    );
  }

  console.log("\n================ 🏆 跑分终极报告 ================");
  console.log(
    `总用例数: ${result.total} | 成功数: ${result.passed} | 成功率: ${(result.passRate * 100).toFixed(2)}%`,
  );
  console.log(
    `总消耗: 输入 ${result.usage.promptTokens} tk | 输出 ${result.usage.completionTokens} tk | ¥${result.usage.costCNY.toFixed(6)}`,
  );
  console.log("==================================================");

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Benchmark 运行失败:", err);
  process.exit(1);
});
