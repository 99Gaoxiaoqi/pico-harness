// 阶段 5 端到端真实测试 — 验证 Auxiliary Client + 版本化迁移在真实大模型下的可用性。
// 用法: npm run test:llm-e2e -- tests/e2e/stage5-e2e.test.ts
//
// 测试目标:
//   1. Auxiliary Client:配 AUX_LLM_* 环境变量,真实模型触发 FullCompactor 压缩,验证 aux 被用
//   2. 版本化迁移:真实 session 跑一轮后,JSONL 首行有当前 meta schemaVersion
//   3. Rate Limit:端点不返回 rate limit header,用 mock header 单测已覆盖,这里验证回调机制可接通
//
// 凭证通过环境变量显式开启:
//   PICO_OPENAI_E2E_BASE_URL / PICO_OPENAI_E2E_API_KEY / PICO_OPENAI_E2E_MODEL
// 未设置时自动 skip。AUX 使用同端点同模型(测试用,生产应配廉价模型)。

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider, Message } from "../../src/provider/interface.js";

const BASE_URL = process.env.PICO_OPENAI_E2E_BASE_URL;
const API_KEY = process.env.PICO_OPENAI_E2E_API_KEY;
const MODEL = process.env.PICO_OPENAI_E2E_MODEL ?? "deepseek-v4-pro";
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1";

// Endpoint health is checked once by the fail-closed global setup. Once opted in,
// request failures in this suite must fail the run instead of silently skipping it.
const describeOrSkip = RUN_LLM_E2E && BASE_URL && API_KEY ? describe : describe.skip;

// 追踪 provider 调用的 wrapper
function createTrackingProvider(real: LLMProvider, calls: { generateCount: number }): LLMProvider {
  return {
    async generate(messages: Message[], tools: unknown[]) {
      calls.generateCount++;
      return real.generate(messages, tools as never);
    },
    generateStream: real.generateStream?.bind(real),
    modelName: real.modelName,
  };
}

describeOrSkip("阶段 5 端到端测试(真实大模型)", { timeout: 180000 }, () => {
  let workDir: string;
  let provider: OpenAIProvider;
  const originalFetch = globalThis.fetch;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-stage5-e2e-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
    writeFileSync(
      join(workDir, "src", "app.ts"),
      ['export const VERSION = "1.0.0";', "export function hello() { return 'hi'; }", ""].join(
        "\n",
      ),
    );
    provider = new OpenAIProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY
    }
  });

  // ─── 测试 1: 版本化迁移 ───
  describe("版本化迁移(5.8)", () => {
    it("真实 session 跑一轮后,JSONL 首行有 meta schemaVersion=3", async () => {
      const session = new Session(`e2e-version-${Date.now()}`, workDir, { persistence: true });
      session.append({ role: "user", content: "你好" });

      const registry = buildDefaultToolRegistry(workDir);
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 2,
        reporter: new SilentReporter(),
      });
      await engine.run(session);
      await session.flushPersistence();

      const sessionLogPath = join(
        resolvePicoPaths(workDir).workspace.sessions,
        `${session.id}.jsonl`,
      );
      const content = readFileSync(sessionLogPath, "utf8");
      const firstLine = content.split("\n")[0]!;
      const record = JSON.parse(firstLine);
      console.log(`[E2E version] JSONL 首行: ${firstLine.slice(0, 100)}`);

      expect(record.type).toBe("meta");
      expect(record.schemaVersion).toBe(3);
    }, 60000);
  });

  // ─── 测试 2: Auxiliary Client 压缩 ───
  describe("Auxiliary Client 压缩(5.3)", () => {
    it("FullCompactor 用 aux provider 压缩(真实模型)", async () => {
      // aux provider 也用同端点同模型(测试验证机制,生产应配廉价模型)
      const auxProvider = new OpenAIProvider({
        baseURL: BASE_URL!,
        apiKey: API_KEY!,
        model: MODEL,
      });

      const mainCalls = { generateCount: 0 };
      const auxCalls = { generateCount: 0 };
      const trackedMain = createTrackingProvider(provider, mainCalls);
      const trackedAux = createTrackingProvider(auxProvider, auxCalls);

      // 构造 FullCompactor,aux 指向 trackedAux
      const fullCompactor = new FullCompactor({
        provider: trackedMain,
        auxProvider: trackedAux,
      });

      // 构造一个需要压缩的长 session
      const session = new Session(`e2e-aux-${Date.now()}`, workDir, { persistence: false });
      // 填入足够多的消息触发压缩(保留最近 2 条,前面都需要压缩)
      for (let i = 0; i < 10; i++) {
        session.append({
          role: "user",
          content: `这是第 ${i + 1} 条历史消息,内容是关于某个函数的讨论。`,
        });
        session.append({
          role: "assistant",
          content: `收到第 ${i + 1} 条,我的回复是关于这个函数的细节。`,
        });
      }

      // 调压缩(保留最近 2 条)
      const success = await fullCompactor.compact(session, {
        inputBudgetTokens: 10_000,
        targetRetainedTokens: 1,
        trigger: "auto",
      });
      console.log(`[E2E aux] 压缩成功: ${success}`);
      console.log(`[E2E aux] main provider 调用次数: ${mainCalls.generateCount}`);
      console.log(`[E2E aux] aux provider 调用次数: ${auxCalls.generateCount}`);

      expect(success, "压缩必须成功,否则无法验证 aux provider 路径").toBe(true);
      expect(auxCalls.generateCount, "压缩应该调 aux provider").toBeGreaterThan(0);
      expect(mainCalls.generateCount, "压缩不应该调 main provider").toBe(0);
      // 至少 session history 被压缩了(变短)
      const history = session.getHistory();
      console.log(`[E2E aux] 压缩后 history 长度: ${history.length}`);
      expect(history.length, "压缩后 history 应该变短").toBeLessThan(20);
    }, 120000);

    it("不配 aux provider 时 FullCompactor 用主 provider(回归)", async () => {
      const mainCalls = { generateCount: 0 };
      const trackedMain = createTrackingProvider(provider, mainCalls);

      const fullCompactor = new FullCompactor({ provider: trackedMain });
      const session = new Session(`e2e-aux-regress-${Date.now()}`, workDir, { persistence: false });
      for (let i = 0; i < 6; i++) {
        session.append({ role: "user", content: `历史消息 ${i}` });
        session.append({ role: "assistant", content: `回复 ${i}` });
      }

      const success = await fullCompactor.compact(session, {
        inputBudgetTokens: 10_000,
        targetRetainedTokens: 1,
        trigger: "auto",
      });
      console.log(`[E2E aux-regress] 压缩成功: ${success}, main 调用: ${mainCalls.generateCount}`);
      expect(success, "压缩必须成功,否则无法验证主 provider fallback").toBe(true);
      expect(mainCalls.generateCount, "不配 aux 应该用主 provider").toBeGreaterThan(0);
    }, 120000);
  });

  // ─── 测试 3: Rate Limit 回调接通 ───
  describe("Rate Limit 回调(5.7)", () => {
    it("onRateLimitInfo 回调在真实 API 调用时被检查(端点无 header 则不触发)", async () => {
      let receivedInfo: unknown = null;
      const providerWithCb = new OpenAIProvider({
        baseURL: BASE_URL!,
        apiKey: API_KEY!,
        model: MODEL,
        onRateLimitInfo: (info) => {
          receivedInfo = info;
        },
      });

      const result = await providerWithCb.generate([{ role: "user", content: "ping" }], []);
      expect(result.content.length).toBeGreaterThan(0);
      console.log(`[E2E ratelimit] 收到 rate limit info: ${JSON.stringify(receivedInfo)}`);
      // 端点不返回 header,receivedInfo 应该是 null(回调未触发)
      // 但回调机制本身被检查了(provider 调了 parseRateLimitHeaders)
    }, 30000);
  });
});

describe("Rate Limit 回调(本地 fixture)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("onRateLimitInfo 命中 header 时必须触发回调", async () => {
    const received: unknown[] = [];
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "x-ratelimit-remaining": "7", "x-ratelimit-limit": "100" }),
        body: null,
        async json() {
          return { choices: [{ message: { role: "assistant", content: "ok" } }] };
        },
        async text() {
          return '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}';
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const providerWithCb = new OpenAIProvider({
      baseURL: "https://fixture.local",
      apiKey: "sk-test",
      model: MODEL,
      onRateLimitInfo: (info) => {
        received.push(info);
      },
    });

    const result = await providerWithCb.generate([{ role: "user", content: "ping" }], []);
    expect(result.content).toBe("ok");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(received).toEqual([expect.objectContaining({ remaining: 7, limit: 100 })]);
  });
});
