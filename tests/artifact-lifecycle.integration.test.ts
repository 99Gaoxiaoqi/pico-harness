import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { SessionManager } from "../src/engine/session.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function waitForClockTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

describe("Session-scoped artifact lifecycle", () => {
  let workDir: string;
  let store: ToolResultArtifactStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-artifact-lifecycle-"));
    store = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
      maxTotalBytes: 8,
    });
    sessions = new SessionManager();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("删除 session 后显式删除该 session 的 artifact 文件", async () => {
    const session = await sessions.getOrCreate("feishu/chat-A", workDir);
    session.append({ role: "user", content: "run tests" });
    const meta = await store.write({
      id: "result-a",
      sessionId: session.id,
      toolName: "bash",
      args: { command: "npm test" },
      output: "raw-a",
      summary: "test output",
      pinned: true,
    });

    expect(meta.id).toBe("result-a");
    expect(meta.sessionId).toBe("feishu/chat-A");
    expect(meta.path).toContain(".claw/artifacts/sessions/");
    expect(meta.path).toContain("/tool-results/");
    await expect(pathExists(meta.path)).resolves.toBe(true);

    const deletedSession = sessions.delete("feishu/chat-A");
    expect(deletedSession).toBe(session);
    const result = await store.deleteSessionArtifacts(deletedSession!.id);

    expect(result.deleted).toEqual(expect.arrayContaining(["result-a"]));
    expect(sessions.get("feishu/chat-A")).toBeUndefined();
    await expect(pathExists(meta.path)).resolves.toBe(false);
    await expect(store.read(meta)).resolves.toBeUndefined();
  });

  it("session cleanup 只清理目标 session,不影响其它 session", async () => {
    const sessionA = await store.write({
      id: "a-1",
      sessionId: "session-A",
      toolName: "bash",
      args: { command: "cat a.log" },
      output: "raw-a",
      ttlHours: 1,
    });
    const sessionB = await store.write({
      id: "b-1",
      sessionId: "session-B",
      toolName: "bash",
      args: { command: "cat b.log" },
      output: "raw-b",
      ttlHours: 1,
    });

    const result = await store.cleanup("session-A", new Date(Date.now() + 2 * 60 * 60 * 1000));

    expect(result.deleted).toEqual(expect.arrayContaining(["a-1"]));
    expect(result.deleted).not.toContain("b-1");
    await expect(pathExists(sessionA.path)).resolves.toBe(false);
    await expect(pathExists(sessionB.path)).resolves.toBe(true);
    await expect(store.read(sessionB)).resolves.toBe("raw-b");
  });

  it("global sweep 在总 quota 超限时跨 session 删除最旧的未 pinned artifact", async () => {
    const oldUnpinned = await store.write({
      id: "old-unpinned",
      sessionId: "session-A",
      toolName: "bash",
      args: { command: "cat old.log" },
      output: "aaaa",
    });
    await waitForClockTick();
    const oldPinned = await store.write({
      id: "old-pinned",
      sessionId: "session-B",
      toolName: "bash",
      args: { command: "cat pinned.log" },
      output: "bbbb",
      pinned: true,
    });
    await waitForClockTick();
    const newUnpinned = await store.write({
      id: "new-unpinned",
      sessionId: "session-C",
      toolName: "bash",
      args: { command: "cat new.log" },
      output: "cccc",
    });

    expect(oldUnpinned.sizeBytes + oldPinned.sizeBytes + newUnpinned.sizeBytes).toBeGreaterThan(8);

    const result = await store.cleanup();

    expect(result.deleted).toEqual(["old-unpinned"]);
    expect(result.retained).toEqual(expect.arrayContaining(["old-pinned", "new-unpinned"]));
    await expect(pathExists(oldUnpinned.path)).resolves.toBe(false);
    await expect(pathExists(oldPinned.path)).resolves.toBe(true);
    await expect(pathExists(newUnpinned.path)).resolves.toBe(true);
  });
});
