import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopConversationStateStore } from "../../src/daemon/desktop-conversation-state.js";

test("desktop conversation state persists only the canonical v2 shape", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-conversation-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "conversation-state.json");
  const workspacePath = join(root, "workspace");
  let sequence = 0;
  const store = new DesktopConversationStateStore({
    filePath,
    now: () => 100 + sequence,
    generateId: () => `queue-${++sequence}`,
  });

  await store.enqueue(workspacePath, "session-1", { kind: "text", text: "hello" });
  await store.rememberIdempotent(workspacePath, "request-1", "fingerprint-1", {
    sessionId: "session-1",
  });

  assert.deepEqual(await store.listQueued(workspacePath, "session-1"), [
    {
      queueId: "queue-1",
      workspacePath,
      sessionId: "session-1",
      input: { kind: "text", text: "hello" },
      createdAt: 101,
    },
  ]);
  assert.deepEqual(await store.getIdempotent(workspacePath, "request-1"), {
    requestFingerprint: "fingerprint-1",
    result: { sessionId: "session-1" },
  });
});

test("desktop conversation state rejects legacy v1 and old field fallbacks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-conversation-state-v1-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "conversation-state.json");
  const workspacePath = join(root, "workspace");
  const store = new DesktopConversationStateStore({ filePath });

  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 1,
      queuedInputs: [],
      idempotency: [],
    })}\n`,
  );
  await assert.rejects(store.listQueued(workspacePath, "session-1"), /format is invalid/u);

  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 2,
      queuedInputs: [
        {
          queueId: "legacy-queue",
          workspacePath,
          sessionId: "session-1",
          text: "legacy top-level text",
          createdAt: 100,
        },
      ],
      idempotency: [],
      firstSendClaims: [],
    })}\n`,
  );
  await assert.rejects(store.listQueued(workspacePath, "session-1"), /missing canonical input/u);

  await writeFile(
    filePath,
    `${JSON.stringify({
      version: 2,
      queuedInputs: [
        {
          queueId: "legacy-input-kind",
          workspacePath,
          sessionId: "session-1",
          input: { text: "missing discriminator" },
          createdAt: 100,
        },
      ],
      idempotency: [],
      firstSendClaims: [],
    })}\n`,
  );
  await assert.rejects(store.listQueued(workspacePath, "session-1"), /invalid input/u);
});
