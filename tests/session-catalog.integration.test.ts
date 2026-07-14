import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCliSessionSummaries } from "../src/cli/session-resolver.js";
import { SessionManager } from "../src/engine/session.js";
import { SessionStore } from "../src/engine/session-store.js";
import type { PersistedSessionSettings } from "../src/engine/session-runtime.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import { SessionCatalog } from "../src/storage/session-catalog.js";
import { readSessionCatalogProjectionHealth } from "../src/storage/session-catalog-projection.js";

describe("Session Catalog integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("uses healthy source markers without replay and rebuilds changed or new journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-catalog-fast-path-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const catalog = new SessionCatalog({ baseDirectory: join(root, "catalog") });
    const manager = new SessionManager();

    for (const [sessionId, content] of [
      ["first", "第一个健康会话"],
      ["second", "第二个健康会话"],
    ] as const) {
      const session = await manager.getOrCreate(sessionId, workDir, {
        persistence: true,
        sessionCatalog: catalog,
      });
      await session.commitMessages({ role: "user", content });
      await session.flushPersistence();
      await session.close();
    }

    const sessionsDirectory = resolvePicoPaths(workDir).workspace.sessions;
    const firstPath = join(sessionsDirectory, "first.jsonl");
    const firstInfo = await stat(firstPath);
    await expect(catalog.list({ sessionProjectDir: workDir })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "first",
          sourceMtimeMs: firstInfo.mtimeMs,
          sourceSizeBytes: firstInfo.size,
        }),
      ]),
    );

    const inspectSpy = vi.spyOn(SessionStore.prototype, "inspectJournal");
    const loadSpy = vi.spyOn(SessionStore.prototype, "load");
    await expect(listCliSessionSummaries(workDir, { catalog })).resolves.toHaveLength(2);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();

    const changed = new SessionStore(firstPath);
    await changed.commitMessage({ role: "user", content: "绕过 Catalog 追加的新消息" });
    await changed.close();
    const newPath = join(sessionsDirectory, "third.jsonl");
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(
      newPath,
      [
        JSON.stringify({ type: "meta", schemaVersion: 1 }),
        JSON.stringify({
          type: "message",
          seq: 0,
          message: { role: "user", content: "目录之外新增的会话" },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    inspectSpy.mockClear();
    loadSpy.mockClear();
    await expect(listCliSessionSummaries(workDir, { catalog })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "first", messageCount: 2 }),
        expect.objectContaining({ id: "second", messageCount: 1 }),
        expect.objectContaining({ id: "third", messageCount: 1 }),
      ]),
    );
    expect(inspectSpy).toHaveBeenCalledTimes(2);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("projects durable commits and fork lineage without replacing JSONL identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-catalog-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const catalog = new SessionCatalog({ baseDirectory: join(root, "catalog") });
    const manager = new SessionManager();

    const source = await manager.getOrCreate("source", workDir, {
      persistence: true,
      sessionCatalog: catalog,
    });
    await source.commitMessages(
      { role: "user", content: "调研持久化方案" },
      { role: "assistant", content: "建议 JSONL 真源与 Catalog 投影分离" },
    );
    source.updateRuntimeState({ settings: persistedSettings("存储架构调研") });
    await source.flushPersistence();

    const sourceEntry = (await catalog.list({ sessionProjectDir: workDir }))[0];
    const sourceHead = source.recordStore?.getHeadCursor();
    expect(sourceEntry).toMatchObject({
      sessionId: "source",
      title: "存储架构调研",
      messageCount: 2,
      health: "healthy",
      lineage: { relation: "root" },
      head: sourceHead,
    });
    expect(sourceEntry?.logId).not.toBe("source");

    const fork = await manager.getOrCreate("forked", workDir, {
      persistence: true,
      sessionCatalog: catalog,
    });
    await fork.seedForkFrom(source, source.getHistory());
    fork.updateRuntimeState({
      settings: persistedSettings("Fork of 存储架构调研", "source"),
    });
    await fork.flushPersistence();

    const entries = await catalog.list({ sessionProjectDir: workDir });
    const forkEntry = entries.find((entry) => entry.sessionId === "forked");
    expect(forkEntry).toMatchObject({
      title: "Fork of 存储架构调研",
      lineage: {
        relation: "fork",
        rootLogId: sourceEntry?.logId,
        parentLogId: sourceEntry?.logId,
        forkEventId: sourceHead?.eventId,
        parentSessionId: "source",
      },
    });

    const browser = await listCliSessionSummaries(workDir, { catalog });
    expect(browser).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "source",
          title: "存储架构调研",
          logId: sourceEntry?.logId,
        }),
        expect.objectContaining({
          id: "forked",
          title: "Fork of 存储架构调研",
          parentLogId: sourceEntry?.logId,
          forkEventId: sourceHead?.eventId,
        }),
      ]),
    );

    await fork.close();
    await source.close();
  });

  it("quarantines a corrupt catalog entry and rebuilds it while the browser keeps the session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-catalog-rebuild-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const catalog = new SessionCatalog({ baseDirectory: join(root, "catalog") });
    const session = await new SessionManager().getOrCreate("recoverable", workDir, {
      persistence: true,
      sessionCatalog: catalog,
    });
    await session.commitMessages({ role: "user", content: "目录损坏后仍要可恢复" });
    await session.flushPersistence();
    const before = (await catalog.list({ sessionProjectDir: workDir }))[0];
    await session.close();

    const entryPath = join(catalog.entriesDirectory, `${before?.logId}.json`);
    await writeFile(entryPath, "{broken catalog", "utf8");

    await expect(listCliSessionSummaries(workDir, { catalog })).resolves.toEqual([
      expect.objectContaining({
        id: "recoverable",
        title: "目录损坏后仍要可恢复",
        messageCount: 1,
        logId: before?.logId,
      }),
    ]);
    await expect(catalog.get(before?.logId ?? "missing")).resolves.toMatchObject({
      sessionId: "recoverable",
      health: "healthy",
    });
    expect(await readdir(catalog.entriesDirectory)).toEqual(
      expect.arrayContaining([
        `${before?.logId}.json`,
        expect.stringMatching(new RegExp(`^${before?.logId}\\.json\\.corrupt\\.`)),
      ]),
    );

    // 把 entries 目录替换成普通文件，模拟 Catalog 不可写。
    await rm(catalog.entriesDirectory, { recursive: true, force: true });
    await writeFile(catalog.entriesDirectory, "catalog unavailable", "utf8");
    const reopened = await new SessionManager().getOrCreate("recoverable", workDir, {
      persistence: true,
      sessionCatalog: catalog,
    });
    await reopened.commitMessages({ role: "assistant", content: "JSONL 提交不应回滚" });
    await expect(reopened.flushPersistence()).resolves.toBeUndefined();
    expect(reopened.getHistory()).toHaveLength(2);
    expect(reopened.sessionCatalogHealth).toMatchObject({ state: "degraded" });
    await expect(readSessionCatalogProjectionHealth(workDir)).resolves.toMatchObject({
      state: "degraded",
      recommendation: expect.stringContaining("/sessions"),
    });
    await expect(listCliSessionSummaries(workDir, { catalog })).resolves.toHaveLength(1);
    await reopened.close();
  });
});

function persistedSettings(title: string, forkFrom?: string): PersistedSessionSettings {
  return {
    title,
    ...(forkFrom ? { forkFrom } : {}),
    provider: "openai",
    model: "test-model",
    mode: "yolo",
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    additionalDirectories: [],
  };
}
