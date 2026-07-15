import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopConversationStateStore } from "../../src/daemon/desktop-conversation-state.js";

describe("DesktopConversationStateStore integration", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("清理过期首发 claim 并将失败记录有界保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-conversation-state-"));
    cleanups.push(root);
    const filePath = join(root, "desktop", "conversation-state.json");
    const workspacePath = join(root, "workspace");
    await mkdir(dirname(filePath), { recursive: true });
    const now = 10_000_000_000_000;
    const recentClaims = Array.from({ length: 501 }, (_, index) => ({
      workspacePath,
      key: `recent-${index}`,
      sessionId: `session-${index}`,
      requestFingerprint: `fingerprint-${index}`,
      createdAt: now - index,
    }));
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        queuedInputs: [],
        idempotency: [],
        firstSendClaims: [
          {
            workspacePath,
            key: "expired",
            sessionId: "expired-session",
            requestFingerprint: "expired-fingerprint",
            createdAt: 0,
          },
          ...recentClaims,
        ],
      }),
      "utf8",
    );
    const store = new DesktopConversationStateStore({ filePath, now: () => now });

    await store.claimFirstSend(workspacePath, "newest", "newest-session", "newest-fingerprint");

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      firstSendClaims: Array<{ key: string }>;
    };
    expect(persisted.firstSendClaims).toHaveLength(500);
    expect(persisted.firstSendClaims[0]?.key).toBe("newest");
    expect(persisted.firstSendClaims.some((claim) => claim.key === "expired")).toBe(false);
  });
});
