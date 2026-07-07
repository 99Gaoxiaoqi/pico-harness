// FullCompactor 辅助模型(auxProvider)单元测试(5.3b)。
//
// 验证两条核心契约:
// 1. 传 auxProvider → FullCompactor.compact 调的是 aux 的 generate(断言 aux.generate 被调,
//    主 provider.generate 没被调),且仍正确应用摘要压缩。
// 2. 不传 auxProvider → 用主 provider(向后兼容回归)。

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullCompactor } from "../../src/context/full-compactor.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { Session } from "../../src/engine/session.js";

/** 极简 Mock Provider:固定返回 content,记录是否被调用 */
class MockProvider implements LLMProvider {
  readonly modelName: string;
  readonly calls: number[] = [];
  constructor(
    private readonly content: string,
    modelName = "mock",
  ) {
    this.modelName = modelName;
  }
  async generate(_messages: Message[], _availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push(1);
    return { role: "assistant", content: this.content };
  }
}

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("FullCompactor 辅助模型(auxProvider)", () => {
  it("传 auxProvider → compact 调 aux.generate,主 provider.generate 不被调", async () => {
    const mainProvider = new MockProvider("主模型摘要(不应被调用)", "main");
    const auxProvider = new MockProvider("辅助模型摘要正文", "aux");
    const fc = new FullCompactor({ provider: mainProvider, auxProvider });

    // 用真实临时 workDir 构造 Session
    const workDir = mkdtempSync(join(tmpdir(), "pico-fc-aux-"));
    const session = new Session("fc-aux-1", workDir);
    session.append(
      userMsg("task1"),
      assistantMsg("step1"),
      userMsg("task2"),
      assistantMsg("step2"),
      userMsg("recent"),
    );

    const ok = await fc.compact(session, 2);
    expect(ok).toBe(true);

    // 核心:aux 被调,主 provider 没被调
    expect(auxProvider.calls).toHaveLength(1);
    expect(mainProvider.calls).toHaveLength(0);

    // 摘要正文正确应用
    const history = session.getHistory();
    expect(history[0]!.role).toBe("assistant");
    expect(history[0]!.content).toContain("辅助模型摘要正文");
    expect(history[0]!.content).toContain("[上下文压缩 — 仅供参考]");
    expect(history[1]!.content).toBe("step2");
    expect(history[2]!.content).toBe("recent");
  });

  it("��传 auxProvider → 用主 provider(向后兼容回归)", async () => {
    const mainProvider = new MockProvider("主模型摘要正文", "main");
    const fc = new FullCompactor({ provider: mainProvider });

    const workDir = mkdtempSync(join(tmpdir(), "pico-fc-aux-"));
    const session = new Session("fc-aux-2", workDir);
    session.append(
      userMsg("task1"),
      assistantMsg("step1"),
      userMsg("task2"),
      assistantMsg("step2"),
      userMsg("recent"),
    );

    const ok = await fc.compact(session, 2);
    expect(ok).toBe(true);

    // 回归:主 provider 被调
    expect(mainProvider.calls).toHaveLength(1);

    const history = session.getHistory();
    expect(history[0]!.content).toContain("主模型摘要正文");
  });
});
