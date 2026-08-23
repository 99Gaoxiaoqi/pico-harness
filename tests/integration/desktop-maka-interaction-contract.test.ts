import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStrictRuntimeParams } from "../../packages/protocol/src/runtime.js";
import { ConversationInteractionSlot } from "../../apps/desktop/src/renderer/conversation/ConversationInteractionSlot.js";
import { groupConversationItemsIntoTurns } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test("new-task send accepts settings that must apply before the first run", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-new-task-settings-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const canonicalWorkspace = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonicalWorkspace);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const sessionId = "maka-style-first-send";
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
    createSessionId: () => sessionId,
  });
  context.after(async () => {
    await desktop.close();
    const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  });

  const parsed = parseStrictRuntimeParams("session.send", {
    workspacePath: workspace,
    input: { kind: "text", text: "检查项目" },
    initialSettings: {
      modelRouteId: "test/coder",
      collaborationMode: "agent",
      orchestrationMode: "default",
      permissionMode: "auto",
    },
    idempotencyKey: "new-task-settings-1",
  });
  assert.equal(parsed.initialSettings?.permissionMode, "auto");

  const sent = asRecord(await desktop.handle(createRuntimeRequest("session.send", parsed)));
  assert.equal(asRecord(sent.session).sessionId, sessionId);
  const settings = asRecord(
    asRecord(
      await desktop.handle(
        createRuntimeRequest("session.settings.get", { workspacePath: workspace, sessionId }),
      ),
    ).settings,
  );
  assert.equal(settings.modelRouteId, "test/coder");
  assert.equal(settings.permissionMode, "auto");

  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath: workspace,
        sessionId,
        input: { kind: "text", text: "不应覆盖既有会话设置" },
        initialSettings: { permissionMode: "yolo" },
        idempotencyKey: "existing-session-settings-1",
      }),
    ),
    /initialSettings 只允许用于首次发送/u,
  );
});

test("desktop transcript groups execution records under the preceding user turn", () => {
  const turns = groupConversationItemsIntoTurns([
    { id: "user-1", kind: "userMessage", text: "第一问" },
    { id: "thinking-1", kind: "thinking", text: "分析" },
    { id: "tool-1", kind: "tool", toolName: "read", title: "读取", state: "done" },
    { id: "assistant-1", kind: "assistantMessage", text: "第一答" },
    { id: "user-2", kind: "userMessage", text: "第二问" },
    { id: "assistant-2", kind: "assistantMessage", text: "第二答" },
  ]);

  assert.deepEqual(
    turns.map((turn) => turn.items.map((item) => item.id)),
    [
      ["user-1", "thinking-1", "tool-1", "assistant-1"],
      ["user-2", "assistant-2"],
    ],
  );
});

test("pending question renders in the composer interaction slot instead of a modal", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    React.createElement(ConversationInteractionSlot, {
      prompt: {
        id: "prompt-1",
        runId: "run-1",
        question: "继续执行吗？",
        options: ["继续", "停止"],
      },
      busy: false,
      onApprovalDecision: () => undefined,
      onPromptAnswer: () => undefined,
    }),
  );

  assert.match(html, /conversation-interaction-slot/u);
  assert.match(html, /继续执行吗/u);
  assert.doesNotMatch(html, /role="dialog"/u);
});
