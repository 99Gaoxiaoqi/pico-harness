import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, SessionManager } from "../../src/engine/session.js";
import { fileHistoryTrackEdit, fileHistoryMakeSnapshot } from "../../src/safety/file-history.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";

describe("FileHistory 1.5.6 对话 undo", () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-undo-"));
    session = new Session("undo-test", workDir, { persistence: false });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function appendRound(n: number): void {
    session.append({ role: "user", content: `user msg ${n}` });
    session.append({ role: "assistant", content: `assistant resp ${n}` });
  }

  it("undo(2) 删除最后 2 轮 user prompt", async () => {
    for (let i = 1; i <= 5; i++) appendRound(i);
    expect(session.length).toBe(10);

    await session.undo(2);

    expect(session.length).toBe(6);
    const users = session.getHistory().filter((m) => m.role === "user");
    expect(users).toHaveLength(3);
    expect(users[0]!.content).toBe("user msg 1");
    expect(users[2]!.content).toBe("user msg 3");
  });

  it("undo(0) 不改变 history", async () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    const before = session.length;

    await session.undo(0);

    expect(session.length).toBe(before);
  });

  it("undo 超过 user 数时截断到开头", async () => {
    for (let i = 1; i <= 3; i++) appendRound(i);

    await session.undo(10);

    expect(session.length).toBe(0);
  });

  it("undo 跳过 system injection 消息", async () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    session.append({ role: "system", content: "injection reminder" });
    session.append({ role: "user", content: "user msg 4" });
    session.append({ role: "assistant", content: "assistant resp 4" });

    await session.undo(1);

    const users = session.getHistory().filter((m) => m.role === "user");
    expect(users).toHaveLength(3);
    expect(users[2]!.content).toBe("user msg 3");
  });

  it("rewindTo 截断到指定 messageIndex", async () => {
    for (let i = 1; i <= 3; i++) appendRound(i);
    expect(session.length).toBe(6);

    await session.rewindTo(2);

    expect(session.length).toBe(2);
    expect(session.getHistory()[0]!.content).toBe("user msg 1");
  });

  it("undo 后 conversationId 变化(fork 语义)", async () => {
    const originalConvId = session.conversationId;
    for (let i = 1; i <= 3; i++) appendRound(i);

    await session.undo(1);

    expect(session.conversationId).not.toBe(originalConvId);
  });

  it("undo 后追加 rewind 事实且保留不可变 message 事实", async () => {
    const persisted = new Session("undo-persist", workDir, { persistence: true });
    await persisted.commitMessages(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );

    await persisted.undo(1);
    await persisted.flushPersistence();

    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const events = await store.readSession("undo-persist");
    expect(events.filter((event) => event.kind === "message.committed")).toHaveLength(4);
    expect(events.findLast((event) => event.kind === "history.rewound")).toBeDefined();
    await persisted.close();
  });

  it("rewindTo 精确持久化消息事件边界", async () => {
    const persisted = new Session("rewind-persist", workDir, { persistence: true });
    await persisted.commitMessages(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );

    await persisted.rewindTo(2);
    await persisted.flushPersistence();

    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const events = await store.readSession("rewind-persist");
    const messages = events.filter((event) => event.kind === "message.committed");
    const rewind = events.findLast((event) => event.kind === "history.rewound");
    expect(messages).toHaveLength(4);
    expect(rewind).toMatchObject({
      kind: "history.rewound",
      data: { throughEventId: messages[1]!.eventId },
    });
    await persisted.close();
  });

  it("rewindConversation 截掉仅 assistant 后缀后可精确恢复", async () => {
    const persisted = new Session("rewind-assistant-only", workDir, { persistence: true });
    await persisted.commitMessages(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    );

    await persisted.rewindConversation(1);
    await persisted.close();

    const recovered = await new SessionManager().getOrCreate("rewind-assistant-only", workDir, {
      persistence: true,
    });

    expect(recovered.getHistory().map((m) => m.content)).toEqual(["u1"]);
    await recovered.close();
  });

  it("recover 重放 undo 事件后截断末尾 user 轮次", async () => {
    const persisted = new Session("undo-recover", workDir, { persistence: true });
    await persisted.commitMessages(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );
    await persisted.undo(1);
    await persisted.flushPersistence();
    await persisted.close();

    const recovered = await new SessionManager().getOrCreate("undo-recover", workDir, {
      persistence: true,
    });

    expect(recovered.length).toBe(2);
    expect(recovered.getHistory().map((m) => m.content)).toEqual(["u1", "a1"]);
    await recovered.close();
  });

  it("undo 超过 compaction 后用户轮次数时保留 summary 边界", async () => {
    const persisted = new Session("undo-compaction", workDir, { persistence: true });
    await persisted.commitMessages(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    );
    await persisted.applyCompaction("summary", 4);
    await persisted.flushPersistence();

    await persisted.undo(10);
    await persisted.flushPersistence();

    expect(persisted.getHistory().map((m) => m.content)).toEqual(["summary"]);
    await persisted.close();
    const recovered = await new SessionManager().getOrCreate("undo-compaction", workDir, {
      persistence: true,
    });
    expect(recovered.getHistory().map((m) => m.content)).toEqual(["summary"]);
    await recovered.close();
  });
});

describe("FileHistory 1.5.7 三轴 rewind", () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-tri-"));
    session = new Session("tri-test", workDir, { persistence: false });
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

    await session.rewindConversation(2);

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

  it("getRewindDiffStat 提供 selector 确认态所需的只读统计", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");

    await fileHistoryTrackEdit(session.fileHistory, src, "turn-1", session.id);
    await fileHistoryMakeSnapshot(session.fileHistory, "turn-1", session.id);
    writeFileSync(src, "original\nnext\n");

    const stat = await session.getRewindDiffStat("turn-1");

    expect(stat).toMatchObject({
      messageId: "turn-1",
      changedFileCount: 1,
      addedLines: 1,
      removedLines: 0,
    });
    expect(readFileSync(src, "utf8")).toBe("original\nnext\n");
  });
});
