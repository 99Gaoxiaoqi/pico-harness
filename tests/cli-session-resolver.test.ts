import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listCliSessionSummaries,
  resolveCliSession,
  type CliSessionSummary,
  type CliSessionSelection,
} from "../src/cli/session-resolver.js";
import {
  createSessionIdentity,
  isSameSessionProjectGroup,
} from "../src/engine/session-identity.js";
import { resolveCliStartupSession } from "../src/cli/session-args.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../src/runtime/runtime-event-store.js";

describe("resolveCliSession", () => {
  it("默认每次启动都创建新的 session id", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    const first = await resolveCliSession({ workDir });
    const second = await resolveCliSession({ workDir });

    expect(first.mode).toBe("new");
    expect(second.mode).toBe("new");
    expect(first.sessionId).toMatch(/^cli-/);
    expect(second.sessionId).toMatch(/^cli-/);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it("--continue 只继续最近的 runtime-event-v1 session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-runtime", "2026-07-09T02:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-runtime");
    await touchSessionFile(workDir, "cli-legacy-newest", "2026-07-09T03:00:00.000Z");

    const selection = await resolveCliSession({ workDir, continueSession: true });

    expect(selection).toEqual<CliSessionSelection>({
      mode: "continue",
      sessionId: "cli-runtime",
    });
  });

  it("列出混合历史来源的 session 摘要并按更新时间倒序排列", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await writeSessionFile(workDir, "cli-old", "2026-07-09T01:00:00.000Z", [
      { type: "meta", schemaVersion: 1 },
      { type: "message", seq: 0, message: { role: "user", content: "old" } },
    ]);
    await writeSessionFile(workDir, "cli-new", "2026-07-09T02:00:00.000Z", [
      { type: "meta", schemaVersion: 1 },
      { type: "message", seq: 0, message: { role: "user", content: "hi" } },
      { type: "message", seq: 1, message: { role: "assistant", content: "hello" } },
    ]);
    await initializeRuntimeSession(workDir, "cli-new");

    const summaries = await listCliSessionSummaries(workDir);

    expect(summaries).toMatchObject<CliSessionSummary[]>([
      {
        id: "cli-new",
        cwd: workDir,
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T02:00:00.000Z"),
        messageCount: 2,
        historySource: "runtime-event-v1",
      },
      {
        id: "cli-old",
        cwd: workDir,
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T01:00:00.000Z"),
        messageCount: 1,
        historySource: "legacy",
      },
    ]);
    expect(summaries[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("session 摘要按事件折叠后的历史计算 messageCount", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await writeSessionFile(workDir, "cli-truncated", "2026-07-09T03:00:00.000Z", [
      { type: "meta", schemaVersion: 1 },
      { type: "message", seq: 0, message: { role: "user", content: "drop me" } },
      { type: "message", seq: 1, message: { role: "assistant", content: "drop me too" } },
      { type: "truncate", seq: 2, fromIndex: 1 },
    ]);

    await expect(listCliSessionSummaries(workDir)).resolves.toMatchObject([
      { id: "cli-truncated", messageCount: 1 },
    ]);
  });

  it("--continue 在当前项目没有 session 时创建新 session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    const selection = await resolveCliSession({ workDir, continueSession: true });

    expect(selection.mode).toBe("new");
    expect(selection.sessionId).toMatch(/^cli-/);
  });

  it("--resume 恢复指定 session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-known", "2026-07-09T01:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-known");

    await expect(resolveCliSession({ workDir, resumeSession: "cli-known" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-known",
    });
  });

  it("--resume 找不到指定 session 时给出明确错误", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    await expect(resolveCliSession({ workDir, resumeSession: "cli-missing" })).rejects.toThrow(
      "无法恢复 session cli-missing",
    );
  });

  it("--session 仍允许指定尚未存在的新 session id", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    await expect(resolveCliSession({ workDir, session: "cli-explicit" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-explicit",
    });
  });

  it("--fork-session 从指定 session 派生新 session id", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-source", "2026-07-09T01:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-source");

    const selection = await resolveCliSession({ workDir, forkSession: "cli-source" });

    expect(selection.mode).toBe("fork");
    expect(selection.sourceSessionId).toBe("cli-source");
    expect(selection.sessionId).toMatch(/^cli-/);
    expect(selection.sessionId).not.toBe("cli-source");
  });

  it("--fork-session 找不到来源 session 时给出明确错误", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    await expect(resolveCliSession({ workDir, forkSession: "cli-missing" })).rejects.toThrow(
      "无法 fork session cli-missing",
    );
  });

  it("legacy session 对显式恢复和 fork 参数只读", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-legacy", "2026-07-09T01:00:00.000Z");

    await expect(resolveCliSession({ workDir, resumeSession: "cli-legacy" })).rejects.toThrow(
      "legacy 历史为只读",
    );
    await expect(resolveCliSession({ workDir, session: "cli-legacy" })).rejects.toThrow(
      "legacy 历史为只读",
    );
    await expect(resolveCliSession({ workDir, forkSession: "cli-legacy" })).rejects.toThrow(
      "legacy 历史为只读",
    );
  });

  it("互斥的 session 启动参数会被拒绝", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    await expect(
      resolveCliSession({
        workDir,
        continueSession: true,
        resumeSession: "cli-known",
      }),
    ).rejects.toThrow("session 启动参数只能选择一种");
  });
});

describe("CLI main session flags", () => {
  it("parses --session/-S with cwd and resolves explicit sessions", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-args-"));

    await expect(
      resolveCliStartupSession(["--dir", workDir, "--session", "cli-explicit"]),
    ).resolves.toEqual({
      workDir: await realpath(workDir),
      sessionSelection: { mode: "resume", sessionId: "cli-explicit" },
    });

    await expect(resolveCliStartupSession(["--dir", workDir, "-S", "cli-short"])).resolves.toEqual({
      workDir: await realpath(workDir),
      sessionSelection: { mode: "resume", sessionId: "cli-short" },
    });
  });

  it("parses --continue/-c and --fork through the real startup resolver", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-args-"));
    await touchSessionFile(workDir, "cli-old", "2026-07-09T01:00:00.000Z");
    await touchSessionFile(workDir, "cli-new", "2026-07-09T02:00:00.000Z");
    await initializeRuntimeSession(workDir, "cli-new");

    await expect(resolveCliStartupSession(["--dir", workDir, "--continue"])).resolves.toEqual({
      workDir: await realpath(workDir),
      sessionSelection: { mode: "continue", sessionId: "cli-new" },
    });
    await expect(resolveCliStartupSession(["--dir", workDir, "-c"])).resolves.toEqual({
      workDir: await realpath(workDir),
      sessionSelection: { mode: "continue", sessionId: "cli-new" },
    });

    const fork = await resolveCliStartupSession(["--dir", workDir, "--fork", "cli-new"]);
    expect(fork.workDir).toBe(await realpath(workDir));
    expect(fork.sessionSelection).toMatchObject({
      mode: "fork",
      sourceSessionId: "cli-new",
    });
    expect(fork.sessionSelection.sessionId).toMatch(/^cli-/);
    expect(fork.sessionSelection.sessionId).not.toBe("cli-new");
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
    const otherRepo = createSessionIdentity({
      sessionId: "cli-other",
      cwd: "/other",
      projectRoot: "/other",
      sessionProjectDir: "/other",
    });

    expect(isSameSessionProjectGroup(main, worktree)).toBe(true);
    expect(isSameSessionProjectGroup(main, otherRepo)).toBe(false);
  });
});

async function touchSessionFile(
  workDir: string,
  sessionId: string,
  timestamp: string,
): Promise<void> {
  const dir = resolvePicoPaths(workDir).workspace.sessions;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), `{"type":"meta","schemaVersion":1}\n`, "utf8");
  const time = new Date(timestamp);
  await utimes(join(dir, `${sessionId}.jsonl`), time, time);
}

async function writeSessionFile(
  workDir: string,
  sessionId: string,
  timestamp: string,
  records: readonly unknown[],
): Promise<void> {
  const dir = resolvePicoPaths(workDir).workspace.sessions;
  const path = join(dir, `${sessionId}.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const time = new Date(timestamp);
  await utimes(path, time, time);
}

async function initializeRuntimeSession(workDir: string, sessionId: string): Promise<void> {
  const paths = resolvePicoPaths(workDir);
  await new RuntimeEventStore({ baseDir: paths.workspace.runs }).initializeSession({
    sessionId,
    workDir: paths.canonicalWorkDir,
  });
}
