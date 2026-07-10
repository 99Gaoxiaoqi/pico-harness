// 阶段 1 端到端真实测试 — 直接用 tsx 运行，不走 vitest
// 用法: npx tsx tests/e2e/run-e2e.ts

import { readFileSync } from "node:fs";
import { OpenAIProvider } from "../../src/provider/openai.js";

// 加载 .env
const env = readFileSync(".env", "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
}

const BASE_URL = process.env.LLM_BASE_URL!;
const API_KEY = process.env.LLM_API_KEY!;
const MODEL = process.env.LLM_MODEL!;

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ ${msg}`);
    failed++;
  }
}

console.log("\n=== 阶段 1 端到端测试（真实 DeepSeek API）===\n");

// ─── 测试 1: 流式输出 ───
console.log("测试 1: 流式输出");
const provider = new OpenAIProvider({ baseURL: BASE_URL, apiKey: API_KEY, model: MODEL });

const deltas: string[] = [];
const result = await provider.generateStream!(
  [{ role: "user", content: "用一句话介绍你自己，不超过30字" }],
  [],
  (delta) => deltas.push(delta),
);

assert(deltas.length > 1, `收到 ${deltas.length} 个 delta（应 >1）`);
assert(deltas.join("") === result.content, "delta 拼接等于最终 content");
assert(result.content.length > 0, `最终内容非空: "${result.content.slice(0, 60)}..."`);
console.log();

// ─── 测试 2: 流式 + 工具调用 ───
console.log("测试 2: 流式模式下的工具调用累积");
const deltas2: string[] = [];
const result2 = await provider.generateStream!(
  [
    { role: "system", content: "你是编码助手。请使用 read_file 工具读取文件。" },
    { role: "user", content: "请读取 hello.txt 文件" },
  ],
  [
    {
      name: "read_file",
      description: "读取文件内容",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  (delta) => deltas2.push(delta),
);

assert(result2.toolCalls !== undefined && result2.toolCalls.length > 0, "模型发出了工具调用");
if (result2.toolCalls && result2.toolCalls.length > 0) {
  const tc = result2.toolCalls[0]!;
  assert(tc.name === "read_file", `工具名: ${tc.name}`);
  try {
    const args = JSON.parse(tc.arguments);
    assert(args.path !== undefined, `参数 path: ${args.path}`);
  } catch {
    assert(false, `arguments 不是有效 JSON: ${tc.arguments}`);
  }
}
console.log();

// ─── 总结 ───
console.log("=== 总结 ===");
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(failed === 0 ? "\n🎉 全部通过！" : `\n⚠ ${failed} 个测试失败`);
process.exit(failed === 0 ? 0 : 1);
