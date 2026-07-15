import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliStartupSession } from "../src/cli/session-args.js";
import {
  listCliSessionSummaries,
  resolveCliSession,
  type CliSessionSelection,
  type CliSessionSummary,
} from "../src/cli/session-resolver.js";
import {
  createSessionIdentity,
  isSameSessionProjectGroup,
} from "../src/engine/session-identity.js";
import { Session } from "../src/engine/session.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import type { Message } from "../src/schema/message.js";
import { RuntimeEventStore } from "../src/runtime/runtime-event-store.js";

describe("resolveCliSession", () => {
  it("默认每次启动都创建新的 session id", async () => {
    const workDir = await temporaryWorkspace();
    const first = await resolveCliSession({ workDir });
    const second = await resolveCliSession({ workDir });

    expect(first.mode).toBe("new");
    expect(second.mode).toBe("new");
    expect(first.sessionId).toMatch(/^cli-/);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("--continue 继续最近更新的 RuntimeEvent session", async () => {
    const workDir = await temporaryWorkspace();
    await initializeRuntimeSession(workDir, "cli-old", "2026-07-09T01:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-new", "2026-07-09T02:00:00.000Z");

    await expect(
      resolveCliSession({ workDir, continueSession: true }),
    ).resolves.toEqual<CliSessionSelection>({ mode: "continue", sessionId: "cli-new" });
  });

  it("从 RuntimeEvent 投影摘要并按更新时间倒序排列", async () => {
    const workDir = await temporaryWorkspace();
    await initializeRuntimeSession(workDir, "cli-old", "2026-07-09T01:00:00.000Z", [
      { role: "user", content: "old prompt" },
    ]);
    await initializeRuntimeSession(workDir, "cli-new", "2026-07-09T02:00:00.000Z", [
      { role: "user", content: "new prompt" },
      { role: "assistant", content: "new answer" },
      { role: "user", content: "latest prompt" },
    ]);

    const summaries = await listCliSessionSummaries(workDir);
    expect(summaries).toMatchObject<CliSessionSummary[]>([
      {
        id: "cli-new",
        cwd: await realpath(workDir),
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T02:00:00.002Z"),
        messageCount: 3,
        title: "new prompt",
        firstMessage: "new prompt",
        lastMessage: "latest prompt",
        historySource: "runtime-event-v1",
      },
      {
        id: "cli-old",
        cwd: await realpath(workDir),
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T01:00:00.000Z"),
        messageCount: 1,
        title: "old prompt",
        historySource: "runtime-event-v1",
      },
    ]);
  });

  it("session.state title 覆盖首条用户消息标题", async () => {
    const workDir = await temporaryWorkspace();
    const store = await initializeRuntimeSession(workDir, "cli-title", "2026-07-09T01:00:00.000Z", [
      { role: "user", content: "first prompt" },
    ]);
    await store.appendSessionState("cli-title", {
      settings: {
        title: "Explicit title",
        provider: "openai",
        model: "model",
        mode: "yolo",
        thinkingEffort: "medium",
        thinkingEffortExplicit: false,
        additionalDirectories: [],
      },
    });

    await expect(listCliSessionSummaries(workDir)).resolves.toMatchObject([
      { id: "cli-title", title: "Explicit title", messageCount: 1 },
    ]);
  });

  it("--continue 在当前项目没有 session 时创建新 session", async () => {
    const selection = await resolveCliSession({
      workDir: await temporaryWorkspace(),
      continueSession: true,
    });
    expect(selection.mode).toBe("new");
    expect(selection.sessionId).toMatch(/^cli-/);
  });

  it("--resume 恢复存在的 session，并拒绝缺失 session", async () => {
    const workDir = await temporaryWorkspace();
    await initializeRuntimeSession(workDir, "cli-known", "2026-07-09T01:00:00.000Z");

    await expect(resolveCliSession({ workDir, resumeSession: "cli-known" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-known",
    });
    await expect(resolveCliSession({ workDir, resumeSession: "cli-missing" })).rejects.toThrow(
      "无法恢复 session cli-missing",
    );
  });

  it("--session 允许指定尚未存在的新 session id", async () => {
    const workDir = await temporaryWorkspace();
    await expect(resolveCliSession({ workDir, session: "cli-explicit" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-explicit",
    });
  });

  it("--fork-session 从存在的 Runtime session 派生新 id", async () => {
    const workDir = await temporaryWorkspace();
    await initializeRuntimeSession(workDir, "cli-source", "2026-07-09T01:00:00.000Z");

    const selection = await resolveCliSession({ workDir, forkSession: "cli-source" });
    expect(selection).toMatchObject({ mode: "fork", sourceSessionId: "cli-source" });
    expect(selection.sessionId).toMatch(/^cli-/);
    await expect(resolveCliSession({ workDir, forkSession: "cli-missing" })).rejects.toThrow(
      "无法 fork session cli-missing",
    );
  });

  it("允许显式恢复已完成 Runtime bootstrap 的 fork", async () => {
    const workDir = await temporaryWorkspace();
    const source = new Session("cli-source", workDir, { persistence: true });
    const target = new Session("cli-fork", workDir, { persistence: true });
    await source.recover();
    await target.recover();
    await source.commitMessages({ role: "user", content: "frozen prompt" });
    await target.seedForkFrom(source, source.getModelContext());
    await Promise.all([source.close(), target.close()]);

    await expect(resolveCliSession({ workDir, session: "cli-fork" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-fork",
    });
  });

  it("互斥的 session 启动参数会被拒绝", async () => {
    await expect(
      resolveCliSession({
        workDir: await temporaryWorkspace(),
        continueSession: true,
        resumeSession: "cli-known",
      }),
    ).rejects.toThrow("session 启动参数只能选择一种");
  });
});

describe("CLI main session flags", () => {
  it("解析 --session/-S、--continue/-c 和 --fork", async () => {
    const workDir = await temporaryWorkspace();
    const canonical = await realpath(workDir);
    await initializeRuntimeSession(workDir, "cli-old", "2026-07-09T01:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-new", "2026-07-09T02:00:00.000Z");

    await expect(
      resolveCliStartupSession(["--dir", workDir, "--session", "cli-explicit"]),
    ).resolves.toEqual({
      workDir: canonical,
      sessionSelection: { mode: "resume", sessionId: "cli-explicit" },
    });
    await expect(resolveCliStartupSession(["--dir", workDir, "-c"])).resolves.toEqual({
      workDir: canonical,
      sessionSelection: { mode: "continue", sessionId: "cli-new" },
    });
    const fork = await resolveCliStartupSession(["--dir", workDir, "--fork", "cli-new"]);
    expect(fork.workDir).toBe(canonical);
    expect(fork.sessionSelection).toMatchObject({ mode: "fork", sourceSessionId: "cli-new" });
  });
});

describe("session identity resume grouping", () => {
  it("同一 repo 的不同 worktree 可被识别为同组候选", () => {
    const main = createSessionIdentity({
      sessionId: "cli-main",
      cwd: "/repo",
      projectRoot: "/repo",
      sessionProjectDir: "/repo",
    });
    const worktree = createSessionIdentity({
      sessionId: "cli-worktree",
      cwd: "/repo-worktree",
      projectRoot: "/repo-worktree",
      sessionProjectDir: "/repo",
    });
    const other = createSessionIdentity({
      sessionId: "cli-other",
      cwd: "/other",
      projectRoot: "/other",
      sessionProjectDir: "/other",
    });

    expect(isSameSessionProjectGroup(main, worktree)).toBe(true);
    expect(isSameSessionProjectGroup(main, other)).toBe(false);
  });
});

async function temporaryWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pico-session-resolver-"));
}

async function initializeRuntimeSession(
  workDir: string,
  sessionId: string,
  timestamp: string,
  messages: readonly Message[] = [],
): Promise<RuntimeEventStore> {
  const paths = resolvePicoPaths(workDir);
  const store = new RuntimeEventStore({ databasePath: paths.workspace.runtimeDatabase });
  const baseTime = new Date(timestamp).getTime();
  await store.initializeSession({
    sessionId,
    workDir: paths.canonicalWorkDir,
    now: () => new Date(baseTime),
  });
  for (const [index, message] of messages.entries()) {
    await store.append({
      schemaVersion: 1,
      eventId: `${sessionId}:message:${index}`,
      sessionId,
      invocationId: `${sessionId}:fixture`,
      runId: `${sessionId}:fixture`,
      turnId: `${sessionId}:fixture`,
      at: new Date(baseTime + index).toISOString(),
      partial: false,
      visibility: "model",
      kind: "message.committed",
      data: { message },
    });
  }
  return store;
}
