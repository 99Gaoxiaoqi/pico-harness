import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(await store.readMeta("result-a")).toMatchObject({
      id: "result-a",
      sessionId: "s1",
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
    expect(await store.read(meta.id)).toBe("hello");
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
});
