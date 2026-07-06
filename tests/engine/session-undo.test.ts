import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../../src/engine/session.js";
import { fileHistoryTrackEdit, fileHistoryMakeSnapshot } from "../../src/safety/file-history.js";

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

describe("FileHistory 1.5.7 三轴 rewind", () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-tri-"));
    session = new Session("tri-test", workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("rewindCode 只回滚文件,对话不变", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");
    session.append({ role: "user", content: "msg1" });
    session.append({ role: "assistant", content: "resp1" });

    await fileHistoryTrackEdit(session.fileHistory, src, "turn-1", session.id);
    await fileHistoryMakeSnapshot(session.fileHistory, "turn-1", session.id);

    writeFileSync(src, "modified\n");
    const historyLenBefore = session.length;

    await session.rewindCode("turn-1");

    expect(readFileSync(src, "utf8")).toBe("original\n");
    expect(session.length).toBe(historyLenBefore);
  });

  it("rewindConversation 只截断对话,文件不变", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");
    session.append({ role: "user", content: "msg1" });
    session.append({ role: "assistant", content: "resp1" });
    session.append({ role: "user", content: "msg2" });
    session.append({ role: "assistant", content: "resp2" });

    await fileHistoryTrackEdit(session.fileHistory, src, "turn-1", session.id);
    await fileHistoryMakeSnapshot(session.fileHistory, "turn-1", session.id);
    writeFileSync(src, "v2\n");

    const originalConvId = session.conversationId;

    session.rewindConversation(2);

    expect(session.length).toBe(2);
    expect(readFileSync(src, "utf8")).toBe("v2\n");
    expect(session.conversationId).not.toBe(originalConvId);
  });

  it("rewindBoth 同时回滚文件和对话", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");
    session.append({ role: "user", content: "msg1" });
    session.append({ role: "assistant", content: "resp1" });
    session.append({ role: "user", content: "msg2" });
    session.append({ role: "assistant", content: "resp2" });

    await fileHistoryTrackEdit(session.fileHistory, src, "turn-1", session.id);
    await fileHistoryMakeSnapshot(session.fileHistory, "turn-1", session.id);
    writeFileSync(src, "modified\n");

    await session.rewindBoth("turn-1", 2);

    expect(readFileSync(src, "utf8")).toBe("original\n");
    expect(session.length).toBe(2);
  });
});
