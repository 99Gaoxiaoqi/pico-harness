import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, SessionManager } from "../../src/engine/session.js";
import { SessionStore } from "../../src/engine/session-store.js";
import { fileHistoryTrackEdit, fileHistoryMakeSnapshot } from "../../src/safety/file-history.js";

async function flushPersistence(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function sessionJsonlPath(workDir: string, id: string): string {
  return join(workDir, ".claw", "sessions", `${id}.jsonl`);
}

describe("SessionStore 1.5.6 undo event sourcing", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-undo-store-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("appendUndoEvent 追加 undo JSONL 记录", async () => {
    const filePath = join(workDir, "session.jsonl");
    const store = new SessionStore(filePath);

    await store.appendUndoEvent(7, 2);

    const records = await store.load();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "undo", seq: 7, count: 2 });
    expect(records[0]).toHaveProperty("at");
  });
});

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

  it("undo 后追加 undo 事件且保留旧 message 记录", async () => {
    const persisted = new Session("undo-persist", workDir, { persistence: true });
    persisted.append({ role: "user", content: "u1" }, { role: "assistant", content: "a1" });
    persisted.append({ role: "user", content: "u2" }, { role: "assistant", content: "a2" });
    await flushPersistence();

    persisted.undo(1);
    await flushPersistence();

    const lines = readFileSync(sessionJsonlPath(workDir, "undo-persist"), "utf8").trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as { type: string; count?: number });
    expect(records.filter((r) => r.type === "message")).toHaveLength(4);
    expect(records.at(-1)).toMatchObject({ type: "undo", count: 1 });
  });

  it("rewindTo 后按移除的 user 轮次数追加 undo 事件", async () => {
    const persisted = new Session("rewind-persist", workDir, { persistence: true });
    persisted.append({ role: "user", content: "u1" }, { role: "assistant", content: "a1" });
    persisted.append({ role: "user", content: "u2" }, { role: "assistant", content: "a2" });
    await flushPersistence();

    persisted.rewindTo(2);
    await flushPersistence();

    const lines = readFileSync(sessionJsonlPath(workDir, "rewind-persist"), "utf8").trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as { type: string; count?: number });
    expect(records.filter((r) => r.type === "message")).toHaveLength(4);
    expect(records.at(-1)).toMatchObject({ type: "undo", count: 1 });
  });

  it("recover 重放 undo 事件后截断末尾 user 轮次", async () => {
    const persisted = new Session("undo-recover", workDir, { persistence: true });
    persisted.append({ role: "user", content: "u1" }, { role: "assistant", content: "a1" });
    persisted.append({ role: "user", content: "u2" }, { role: "assistant", content: "a2" });
    await flushPersistence();
    persisted.undo(1);
    await flushPersistence();

    const recovered = await new SessionManager().getOrCreate("undo-recover", workDir, { persistence: true });

    expect(recovered.length).toBe(2);
    expect(recovered.getHistory().map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("undo 超过 compaction 后用户轮次数时保留 summary 边界", async () => {
    const persisted = new Session("undo-compaction", workDir, { persistence: true });
    persisted.append({ role: "user", content: "u1" }, { role: "assistant", content: "a1" });
    persisted.append({ role: "user", content: "u2" }, { role: "assistant", content: "a2" });
    persisted.append({ role: "user", content: "u3" }, { role: "assistant", content: "a3" });
    await flushPersistence();
    persisted.applyCompaction("summary", 4);
    await flushPersistence();

    persisted.undo(10);
    await flushPersistence();

    expect(persisted.getHistory().map((m) => m.content)).toEqual(["summary"]);
    const recovered = await new SessionManager().getOrCreate("undo-compaction", workDir, { persistence: true });
    expect(recovered.getHistory().map((m) => m.content)).toEqual(["summary"]);
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
