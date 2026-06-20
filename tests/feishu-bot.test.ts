import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentEngine } from "../src/engine/loop.js";
import type { Reporter } from "../src/engine/reporter.js";
import type { Session } from "../src/engine/session.js";
import { FeishuBot, type FeishuAgentRunContext } from "../src/feishu/bot.js";

describe("FeishuBot AgentOps 调度", () => {
  it("每个 chat 使用独立 Session、Reporter 和动态 Engine", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-feishu-"));
    const sent: Array<{ receiveId: string; text: string }> = [];
    const fakeClient = {
      im: {
        message: {
          create: vi.fn(async (payload: { data: { receive_id: string; content: string } }) => {
            const content = JSON.parse(payload.data.content) as { text: string };
            sent.push({ receiveId: payload.data.receive_id, text: content.text });
            return {};
          }),
        },
      },
    } as unknown as Client;
    const seen: Array<{ chatId: string; sessionId: string; reporter: Reporter }> = [];
    const bot = new FeishuBot(
      (context: FeishuAgentRunContext) => {
        seen.push({
          chatId: context.chatId,
          sessionId: context.session.id,
          reporter: context.reporter,
        });
        return {
          run: async (session: Session, reporter: Reporter) => {
            expect(session).toBe(context.session);
            expect(reporter).toBe(context.reporter);
            reporter.onMessage(`done:${context.chatId}`);
            return [];
          },
        } as unknown as AgentEngine;
      },
      { appId: "app", appSecret: "secret" },
      workDir,
      fakeClient,
    );
    const runner = bot as unknown as {
      runAgentAndReport(chatId: string, prompt: string): Promise<void>;
    };

    await Promise.all([
      runner.runAgentAndReport("chat-a", "查一下 A"),
      runner.runAgentAndReport("chat-b", "查一下 B"),
    ]);

    expect(seen.map((item) => ({ chatId: item.chatId, sessionId: item.sessionId }))).toEqual([
      { chatId: "chat-a", sessionId: "feishu:chat-a" },
      { chatId: "chat-b", sessionId: "feishu:chat-b" },
    ]);
    expect(seen[0]?.reporter).not.toBe(seen[1]?.reporter);
    expect(sent).toEqual(
      expect.arrayContaining([
        { receiveId: "chat-a", text: "🤖 done:chat-a" },
        { receiveId: "chat-b", text: "🤖 done:chat-b" },
      ]),
    );
  });
});
