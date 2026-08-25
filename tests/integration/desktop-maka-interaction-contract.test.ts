import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseStrictRuntimeParams } from "../../packages/protocol/src/runtime.js";
import { ConversationInteractionSlot } from "../../apps/desktop/src/renderer/conversation/ConversationInteractionSlot.js";
import { groupConversationItemsIntoTurns } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import {
  omitApprovalAuditItems,
  removeSupersededActiveTools,
} from "../../apps/desktop/src/renderer/conversation/items.js";
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

test("terminal transcript removes only an approval-gated stale active tool duplicate", () => {
  const items = [
    {
      id: "tool-before-approval",
      kind: "tool" as const,
      toolName: "write_file",
      title: "write_file",
      detail: '{"path":"result.txt"}',
      state: "active" as const,
    },
    {
      id: "approval",
      kind: "approval" as const,
      title: "写入文件",
      detail: "等待确认",
      state: "allowed" as const,
    },
    {
      id: "tool-completed",
      kind: "tool" as const,
      toolName: "write_file",
      title: "write_file",
      detail: "Tool completed · 55 bytes",
      state: "done" as const,
    },
  ];

  assert.deepEqual(
    removeSupersededActiveTools(items, false).map((item) => item.id),
    ["approval", "tool-completed"],
  );
  assert.equal(removeSupersededActiveTools(items, true), items);
});

test("terminal run boundaries clear unresolved tool-start placeholders", () => {
  const items = [
    {
      id: "stale-tool",
      kind: "tool" as const,
      toolName: "bash",
      title: "bash",
      state: "active" as const,
    },
    {
      id: "run-completed",
      kind: "runBoundary" as const,
      status: "completed" as const,
      label: "运行完成",
    },
    { id: "next-user", kind: "userMessage" as const, text: "下一轮" },
    {
      id: "current-tool",
      kind: "tool" as const,
      toolName: "read_file",
      title: "read_file",
      state: "active" as const,
    },
  ];

  assert.deepEqual(
    removeSupersededActiveTools(items, true).map((item) => item.id),
    ["run-completed", "next-user", "current-tool"],
  );
});

test("approval audit items stay out of the main transcript", () => {
  const visible = omitApprovalAuditItems([
    { id: "answer", kind: "assistantMessage" as const, text: "完成" },
    {
      id: "approval:1",
      kind: "approval" as const,
      title: "Approval granted",
      detail: "Runtime 请求执行受保护操作。",
      state: "allowed" as const,
    },
  ]);

  assert.deepEqual(
    visible.map((item) => item.id),
    ["answer"],
  );
});

test("persisted approvals recover the interaction slot and disappear after terminal runs", async () => {
  const appSource = await readFile(
    new URL("../../apps/desktop/src/renderer/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(appSource, /persistedPendingApproval/u);
  assert.match(appSource, /omitApprovalAuditItems/u);
  assert.match(appSource, /item\.id\.startsWith\("approval:"\)/u);
  assert.match(
    appSource,
    /Boolean\(activeRun\)[\s\S]*?item\.kind === "approval" \|\| item\.kind === "prompt"[\s\S]*?item\.state === "pending"/u,
  );
});

test("a recovered continuity replica clears a transient conversation load error", async () => {
  const runtimeSource = await readFile(
    new URL("../../apps/desktop/src/renderer/runtime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    runtimeSource,
    /loadError:\s*_previousLoadError,[\s\S]*?\.\.\.conversationWithoutRun/u,
  );
});

test("desktop dev refreshes optimized workspace dependencies before continuity opens", async () => {
  const viteConfig = await readFile(
    new URL("../../apps/desktop/vite.renderer.config.ts", import.meta.url),
    "utf8",
  );

  assert.match(viteConfig, /optimizeDeps:\s*\{[\s\S]*?force:\s*true/u);
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
