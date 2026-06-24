import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface FutureArtifactLifecycleOptions {
  baseDir: string;
  maxTotalBytes?: number;
  cleanupAfterWrite?: boolean;
}

interface FutureWriteToolResultInput {
  sessionId: string;
  artifactId: string;
  toolName: string;
  args: unknown;
  output: string;
  summary?: string;
  createdAt?: Date;
  ttlHours?: number;
  pinned?: boolean;
}

interface FutureArtifactMeta {
  id: string;
  sessionId: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  pinned: boolean;
}

interface FutureCleanupResult {
  deleted: string[];
  retained: string[];
}

interface FutureArtifactLifecycle {
  writeToolResult(input: FutureWriteToolResultInput): Promise<FutureArtifactMeta>;
  readToolResult(input: { sessionId: string; artifactId: string }): Promise<string | undefined>;
  cleanupSession(sessionId: string): Promise<FutureCleanupResult>;
  deleteSession(sessionId: string): Promise<FutureCleanupResult>;
  sweepGlobalQuota(): Promise<FutureCleanupResult>;
}

function createFutureArtifactLifecycle(
  _opts: FutureArtifactLifecycleOptions,
): FutureArtifactLifecycle {
  throw new Error("Wire this draft to the final session-scoped artifact lifecycle API.");
}

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

describe.skip("Session-scoped artifact lifecycle (future API)", () => {
  let workDir: string;
  let lifecycle: FutureArtifactLifecycle;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-artifact-lifecycle-"));
    lifecycle = createFutureArtifactLifecycle({
      baseDir: join(workDir, ".claw", "artifacts"),
      maxTotalBytes: 8,
      cleanupAfterWrite: false,
    });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("deleteSession 删除 session 后 artifact 文件消失", async () => {
    const meta = await lifecycle.writeToolResult({
      sessionId: "feishu/chat-A",
      artifactId: "result-a",
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

    const result = await lifecycle.deleteSession("feishu/chat-A");

    expect(result.deleted).toEqual(expect.arrayContaining(["result-a"]));
    await expect(pathExists(meta.path)).resolves.toBe(false);
    await expect(
      lifecycle.readToolResult({ sessionId: "feishu/chat-A", artifactId: "result-a" }),
    ).resolves.toBeUndefined();
  });

  it("cleanupSession 只清理目标 session,不影响其它 session", async () => {
    const sessionA = await lifecycle.writeToolResult({
      sessionId: "session-A",
      artifactId: "a-1",
      toolName: "bash",
      args: { command: "cat a.log" },
      output: "raw-a",
    });
    const sessionB = await lifecycle.writeToolResult({
      sessionId: "session-B",
      artifactId: "b-1",
      toolName: "bash",
      args: { command: "cat b.log" },
      output: "raw-b",
    });

    const result = await lifecycle.cleanupSession("session-A");

    expect(result.deleted).toEqual(expect.arrayContaining(["a-1"]));
    expect(result.deleted).not.toContain("b-1");
    await expect(pathExists(sessionA.path)).resolves.toBe(false);
    await expect(pathExists(sessionB.path)).resolves.toBe(true);
    await expect(
      lifecycle.readToolResult({ sessionId: "session-B", artifactId: "b-1" }),
    ).resolves.toBe("raw-b");
  });

  it("global sweep 在总 quota 超限时跨 session 删除最旧的未 pinned artifact", async () => {
    const oldUnpinned = await lifecycle.writeToolResult({
      sessionId: "session-A",
      artifactId: "old-unpinned",
      toolName: "bash",
      args: { command: "cat old.log" },
      output: "aaaa",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const oldPinned = await lifecycle.writeToolResult({
      sessionId: "session-B",
      artifactId: "old-pinned",
      toolName: "bash",
      args: { command: "cat pinned.log" },
      output: "bbbb",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      pinned: true,
    });
    const newUnpinned = await lifecycle.writeToolResult({
      sessionId: "session-C",
      artifactId: "new-unpinned",
      toolName: "bash",
      args: { command: "cat new.log" },
      output: "cccc",
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
    });

    expect(oldUnpinned.sizeBytes + oldPinned.sizeBytes + newUnpinned.sizeBytes).toBeGreaterThan(8);

    const result = await lifecycle.sweepGlobalQuota();

    expect(result.deleted).toEqual(["old-unpinned"]);
    expect(result.retained).toEqual(expect.arrayContaining(["old-pinned", "new-unpinned"]));
    await expect(pathExists(oldUnpinned.path)).resolves.toBe(false);
    await expect(pathExists(oldPinned.path)).resolves.toBe(true);
    await expect(pathExists(newUnpinned.path)).resolves.toBe(true);
  });
});
