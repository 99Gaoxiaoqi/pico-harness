import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/engine/session.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import type { Message } from "../src/schema/message.js";

const ON = { persistence: true } as const;
const OFF = { persistence: false } as const;

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        String(error).includes("EBUSY") ||
        String(error).includes("EPERM") ||
        String(error).includes("ENOTEMPTY")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

describe("Session RuntimeEvent persistence", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-session-runtime-"));
  });

  afterEach(async () => {
    await safeRm(resolvePicoPaths(workDir).workspace.root);
    await safeRm(workDir);
  });

  it("recovers committed history after a manager restart", async () => {
    const firstManager = new SessionManager();
    const first = await firstManager.getOrCreate("chat-X", workDir, ON);
    await first.commitMessages(userMsg("hello"), assistantMsg("world"));
    await first.close();

    const restarted = await new SessionManager().getOrCreate("chat-X", workDir, ON);
    expect(restarted.getHistory()).toEqual([userMsg("hello"), assistantMsg("world")]);
    await restarted.close();
  });

  it("stores conversation facts only in runtime.sqlite", async () => {
    const session = await new SessionManager().getOrCreate("single-authority", workDir, ON);
    await session.commitMessages(userMsg("durable fact"));
    await session.flushPersistence();

    const workspace = resolvePicoPaths(workDir).workspace;
    await expect(access(workspace.runtimeDatabase)).resolves.toBeUndefined();
    await expect(access(join(workspace.root, "sessions"))).rejects.toThrow();
    await session.close();
  });

  it("persists truncation and subsequent appends in event order", async () => {
    const first = await new SessionManager().getOrCreate("chat-truncate", workDir, ON);
    await first.commitMessages(userMsg("m0"), userMsg("m1"), userMsg("m2"), userMsg("m3"));
    await first.truncateTo(2);
    await first.commitMessages(userMsg("m4"));
    expect(first.getHistory()).toEqual([userMsg("m2"), userMsg("m3"), userMsg("m4")]);
    await first.close();

    const restarted = await new SessionManager().getOrCreate("chat-truncate", workDir, ON);
    expect(restarted.getHistory()).toEqual([userMsg("m2"), userMsg("m3"), userMsg("m4")]);
    await restarted.close();
  });

  it("continues appending after recovery without replacing earlier facts", async () => {
    const first = await new SessionManager().getOrCreate("chat-sequence", workDir, ON);
    await first.commitMessages(userMsg("first"));
    await first.close();

    const second = await new SessionManager().getOrCreate("chat-sequence", workDir, ON);
    await second.commitMessages(userMsg("second"));
    await second.close();

    const third = await new SessionManager().getOrCreate("chat-sequence", workDir, ON);
    expect(third.getHistory()).toEqual([userMsg("first"), userMsg("second")]);
    await third.close();
  });

  it("isolates multiple sessions inside the shared database", async () => {
    const manager = new SessionManager();
    const sessionA = await manager.getOrCreate("feishu:group/A", workDir, ON);
    const sessionB = await manager.getOrCreate("feishu:group/B", workDir, ON);
    await Promise.all([
      sessionA.commitMessages(userMsg("message A")),
      sessionB.commitMessages(userMsg("message B")),
    ]);
    await Promise.all([sessionA.close(), sessionB.close()]);

    const restarted = new SessionManager();
    const recoveredA = await restarted.getOrCreate("feishu:group/A", workDir, ON);
    const recoveredB = await restarted.getOrCreate("feishu:group/B", workDir, ON);
    expect(recoveredA.getHistory()).toEqual([userMsg("message A")]);
    expect(recoveredB.getHistory()).toEqual([userMsg("message B")]);
    await Promise.all([recoveredA.close(), recoveredB.close()]);
  });

  it("supports session IDs that are not valid file names", async () => {
    const first = await new SessionManager().getOrCreate("feishu:group/1", workDir, ON);
    await first.commitMessages(userMsg("special id"));
    await first.close();

    const restarted = await new SessionManager().getOrCreate("feishu:group/1", workDir, ON);
    expect(restarted.getHistory()).toEqual([userMsg("special id")]);
    await restarted.close();
  });

  it("keeps persistence:false sessions process-local", async () => {
    const first = await new SessionManager().getOrCreate("chat-off", workDir, OFF);
    first.append(userMsg("memory only"));
    await first.flushPersistence();
    await first.close();

    const restarted = await new SessionManager().getOrCreate("chat-off", workDir, OFF);
    expect(restarted.length).toBe(0);
    await restarted.close();
  });
});
