import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
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

  it("--continue 继续当前项目最近一次 session", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-old", "2026-07-09T01:00:00.000Z");
    await touchSessionFile(workDir, "cli-new", "2026-07-09T02:00:00.000Z");

    const selection = await resolveCliSession({ workDir, continueSession: true });

    expect(selection).toEqual<CliSessionSelection>({
      mode: "continue",
      sessionId: "cli-new",
    });
  });

  it("列出当前项目可恢复 session 摘要并按更新时间倒序排列", async () => {
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

    const summaries = await listCliSessionSummaries(workDir);

    expect(summaries).toMatchObject<CliSessionSummary[]>([
      {
        id: "cli-new",
        cwd: workDir,
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T02:00:00.000Z"),
        messageCount: 2,
      },
      {
        id: "cli-old",
        cwd: workDir,
        createdAt: expect.any(Date) as Date,
        updatedAt: new Date("2026-07-09T01:00:00.000Z"),
        messageCount: 1,
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

  it("legacy --session keeps allowing an explicit id without pre-existing history", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));

    await expect(resolveCliSession({ workDir, session: "cli-explicit" })).resolves.toEqual({
      mode: "resume",
      sessionId: "cli-explicit",
    });
  });

  it("--fork-session 从指定 session 派生新 session id", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-session-resolver-"));
    await touchSessionFile(workDir, "cli-source", "2026-07-09T01:00:00.000Z");

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
  it("registers resolver-backed session flags and short aliases", async () => {
    const source = await readFile(join(process.cwd(), "src", "cli", "main.ts"), "utf8");

    expect(source).toContain('session: { type: "string", short: "S" }');
    expect(source).toContain('"continue": { type: "boolean", short: "c" }');
    expect(source).toContain('"fork": { type: "string" }');
    expect(source).toContain("resolveCliSession");
    expect(source).toContain("sessionSelection");
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
  const dir = join(workDir, ".claw", "sessions");
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
  const dir = join(workDir, ".claw", "sessions");
  const path = join(dir, `${sessionId}.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const time = new Date(timestamp);
  await utimes(path, time, time);
}
