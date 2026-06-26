import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// 测试侧也用 pathe,与 artifact-store 的 meta.path(正斜杠)保持一致。
import { join } from "pathe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";

describe("ToolResultArtifactStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pico-artifacts-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("写入后可读取原文和 metadata", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir });

    const meta = await store.write({
      id: "result-a",
      sessionId: "s1",
      toolName: "bash",
      args: { command: "npm test" },
      output: "hello",
      summary: "short",
    });

    expect(meta.id).toBe("result-a");
    expect(meta.sizeBytes).toBe(5);
    expect(await store.read(meta)).toBe("hello");
    expect(meta.sessionId).toBe("s1");
    expect(meta.safeSessionId).toBe("s1");
    expect(meta.path).toBe(join(dir, "sessions", "s1", "tool-results", "result-a.txt"));
    expect(await readFile(meta.path, "utf8")).toBe("hello");
    expect(await store.readMeta("result-a", "s1")).toMatchObject({
      id: "result-a",
      sessionId: "s1",
      safeSessionId: "s1",
      toolName: "bash",
      summary: "short",
      pinned: false,
    });
  });

  it("未指定 id 时自动生成安全 id", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir });

    const meta = await store.write({
      toolName: "bash",
      args: {},
      output: "hello",
    });

    expect(meta.id).toMatch(/^tool-result-\d+-\d+$/);
    expect(meta.sessionId).toBe("default");
    expect(meta.safeSessionId).toBe("default");
    expect(await store.read(meta.id)).toBe("hello");
  });

  it("不同 session 的同名 artifact 物理隔离且互不覆盖", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir });

    const left = await store.write({
      id: "same",
      sessionId: "session/a",
      toolName: "bash",
      args: {},
      output: "left",
    });
    const right = await store.write({
      id: "same",
      sessionId: "session:b",
      toolName: "bash",
      args: {},
      output: "right",
    });

    expect(left.sessionId).toBe("session/a");
    expect(right.sessionId).toBe("session:b");
    expect(left.safeSessionId).toMatch(/^session_a-[a-f0-9]{12}$/);
    expect(right.safeSessionId).toMatch(/^session_b-[a-f0-9]{12}$/);
    expect(left.path).toBe(join(dir, "sessions", left.safeSessionId, "tool-results", "same.txt"));
    expect(right.path).toBe(join(dir, "sessions", right.safeSessionId, "tool-results", "same.txt"));
    expect(await store.read(left)).toBe("left");
    expect(await store.read(right)).toBe("right");
    expect(await store.readMeta("same", "session/a")).toMatchObject({
      id: "same",
      sessionId: "session/a",
      safeSessionId: left.safeSessionId,
      path: left.path,
    });
    expect(await store.readMeta("same", "session:b")).toMatchObject({
      id: "same",
      sessionId: "session:b",
      safeSessionId: right.safeSessionId,
      path: right.path,
    });
  });

  it("cleanup 删除过期且未 pinned 的 artifact", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir, ttlHours: 1 });
    await store.write({ id: "old", toolName: "bash", args: {}, output: "old" });
    await store.write({ id: "new", toolName: "bash", args: {}, output: "new", ttlHours: 24 });

    const result = await store.cleanup(new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(result.deleted).toEqual(["old"]);
    expect(await store.read("old")).toBeUndefined();
    expect(await store.read("new")).toBe("new");
  });

  it("cleanup 指定 session 时不影响其它 session", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir, ttlHours: 1 });
    const left = await store.write({
      id: "same",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "left",
    });
    const right = await store.write({
      id: "same",
      sessionId: "session-b",
      toolName: "bash",
      args: {},
      output: "right",
    });

    const result = await store.cleanup("session-a", new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(result.deleted).toEqual(["same"]);
    expect(await store.read(left)).toBeUndefined();
    expect(await store.read(right)).toBe("right");
    expect(await store.readMeta("same", "session-a")).toBeUndefined();
    expect(await store.readMeta("same", "session-b")).toMatchObject({
      id: "same",
      sessionId: "session-b",
    });
  });

  it("cleanup 保留过期但 pinned 的 artifact", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir, ttlHours: 1 });
    await store.write({ id: "keep", toolName: "bash", args: {}, output: "old", pinned: true });

    const result = await store.cleanup(new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(result.deleted).toEqual([]);
    expect(result.retained).toEqual(["keep"]);
    expect(await store.read("keep")).toBe("old");
  });

  it("超过 quota 时优先删除最旧未 pinned artifact", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir, maxTotalBytes: 8 });
    await store.write({ id: "a", toolName: "bash", args: {}, output: "aaaa" });
    await store.write({ id: "b", toolName: "bash", args: {}, output: "bbbb", pinned: true });
    await store.write({ id: "c", toolName: "bash", args: {}, output: "cccc" });

    const result = await store.cleanup();

    expect(result.deleted).toEqual(["a"]);
    expect(await store.read("a")).toBeUndefined();
    expect(await store.read("b")).toBe("bbbb");
    expect(await store.read("c")).toBe("cccc");
  });

  it("deleteSessionArtifacts 删除该 session 下包含 pinned 在内的所有 artifact", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir });
    const pinned = await store.write({
      id: "pinned",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "pinned",
      pinned: true,
    });
    const regular = await store.write({
      id: "regular",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "regular",
    });
    const other = await store.write({
      id: "other",
      sessionId: "session-b",
      toolName: "bash",
      args: {},
      output: "other",
      pinned: true,
    });

    const result = await store.deleteSessionArtifacts("session-a");

    expect(result.deleted.toSorted()).toEqual(["pinned", "regular"]);
    expect(result.retained).toEqual([]);
    expect(await store.read(pinned)).toBeUndefined();
    expect(await store.read(regular)).toBeUndefined();
    expect(await store.read(other)).toBe("other");
  });

  it("全局 cleanup 仍跨 session 按 quota 兜底", async () => {
    const store = new ToolResultArtifactStore({ baseDir: dir, maxTotalBytes: 8 });
    const oldest = await store.write({
      id: "a",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "aaaa",
    });
    const pinned = await store.write({
      id: "b",
      sessionId: "session-a",
      toolName: "bash",
      args: {},
      output: "bbbb",
      pinned: true,
    });
    const newest = await store.write({
      id: "c",
      sessionId: "session-b",
      toolName: "bash",
      args: {},
      output: "cccc",
    });

    const result = await store.cleanup();

    expect(result.deleted).toEqual(["a"]);
    expect(await store.read(oldest)).toBeUndefined();
    expect(await store.read(pinned)).toBe("bbbb");
    expect(await store.read(newest)).toBe("cccc");
  });
});
