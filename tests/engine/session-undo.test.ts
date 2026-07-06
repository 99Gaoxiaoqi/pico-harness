import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../../src/engine/session.js";

describe("FileHistory 1.5.6 对话 undo", () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-undo-"));
    session = new Session("undo-test", workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function appendRound(n: number): void {
    session.append({ role: "user", content: `user msg ${n}` });
    session.append({ role: "assistant", content: `assistant resp ${n}` });
  }

  it("undo(2) 删除最后 2 轮 user prompt", () => {
    for (let i = 1; i <= 5; i++) appendRound(i);
    expect(session.length).toBe(10);

    session.undo(2);

    expect(session.length).toBe(6);
    const users = session.getHistory().filter((m) => m.role === "user");
    expect(users).toHaveLength(3);
    expect(users[0]!.content).toBe("user msg 1");
    expect(users[2]!.content).toBe("user msg 3");
  });

  it("undo(0) 不改变 history", () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    const before = session.length;

    session.undo(0);

    expect(session.length).toBe(before);
  });

  it("undo 超过 user 数时截断到开头", () => {
    for (let i = 1; i <= 3; i++) appendRound(i);

    session.undo(10);

    expect(session.length).toBe(0);
  });

  it("undo 跳过 system injection 消息", () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    session.append({ role: "system", content: "injection reminder" });
    session.append({ role: "user", content: "user msg 4" });
    session.append({ role: "assistant", content: "assistant resp 4" });

    session.undo(1);

    const users = session.getHistory().filter((m) => m.role === "user");
    expect(users).toHaveLength(3);
    expect(users[2]!.content).toBe("user msg 3");
  });

  it("rewindTo 截断到指定 messageIndex", () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    expect(session.length).toBe(6);

    session.rewindTo(2);

    expect(session.length).toBe(2);
    expect(session.getHistory()[0]!.content).toBe("user msg 1");
  });

  it("undo 后 conversationId 变化(fork 语义)", () => {
    const originalConvId = session.conversationId;
    for (let i = 1; i <= 3; i++) appendRound(i);

    session.undo(1);

    expect(session.conversationId).not.toBe(originalConvId);
  });
});
