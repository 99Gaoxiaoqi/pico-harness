import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { parseDesktopConversationStateFile } from "../../src/daemon/desktop-conversation-state.js";

test("desktop conversation state parser accepts only the canonical v2 shape", () => {
  const workspacePath = join("fixture", "workspace");
  assert.deepEqual(
    parseDesktopConversationStateFile(
      {
        version: 2,
        queuedInputs: [
          {
            queueId: "queue-1",
            workspacePath,
            sessionId: "session-1",
            input: { kind: "text", text: "hello" },
            createdAt: 101,
          },
        ],
        idempotency: [
          {
            workspacePath,
            key: "request-1",
            requestFingerprint: "fingerprint-1",
            result: { sessionId: "session-1" },
            createdAt: 102,
          },
        ],
        firstSendClaims: [],
      },
      "conversation-state.json",
    ),
    {
      version: 2,
      queuedInputs: [
        {
          queueId: "queue-1",
          workspacePath: join(process.cwd(), workspacePath),
          sessionId: "session-1",
          input: { kind: "text", text: "hello" },
          createdAt: 101,
        },
      ],
      idempotency: [
        {
          workspacePath: join(process.cwd(), workspacePath),
          key: "request-1",
          requestFingerprint: "fingerprint-1",
          result: { sessionId: "session-1" },
          createdAt: 102,
        },
      ],
      firstSendClaims: [],
    },
  );
});

test("desktop conversation state parser rejects v1 and old field fallbacks", () => {
  const workspacePath = join("fixture", "workspace");
  assert.throws(
    () =>
      parseDesktopConversationStateFile(
        { version: 1, queuedInputs: [], idempotency: [] },
        "conversation-state.json",
      ),
    /format is invalid/u,
  );

  assert.throws(
    () =>
      parseDesktopConversationStateFile(
        {
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
        },
        "conversation-state.json",
      ),
    /missing canonical input/u,
  );

  assert.throws(
    () =>
      parseDesktopConversationStateFile(
        {
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
        },
        "conversation-state.json",
      ),
    /invalid input/u,
  );
});
