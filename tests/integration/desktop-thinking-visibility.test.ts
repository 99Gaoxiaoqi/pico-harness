import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../apps/desktop/src/renderer/conversation/ConversationTranscript.js";
import { applyTimelineNotification } from "../../apps/desktop/src/renderer/timeline.js";
import { DesktopReporter } from "../../src/daemon/desktop-reporter.js";
import type { RuntimeNotification } from "../../src/daemon/protocol.js";
import { publishDesktopReporterEvent } from "../../src/daemon/production-host.js";
import type { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

test("Desktop run announces model inference before a provider without reasoning content", async (context) => {
  const events: Array<{
    readonly type: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  }> = [];
  const session = new Session("desktop-thinking-status", process.cwd(), { persistence: false });
  context.after(() => session.close());
  const reporter = new DesktopReporter({
    runId: "run-thinking-status",
    sessionId: session.id,
    publish: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  const engine = new AgentEngine({
    workDir: process.cwd(),
    registry: new ToolRegistry(),
    reporter,
    provider: {
      async generate() {
        events.push({ type: "provider.generate" });
        return { role: "assistant", content: "完成。" };
      },
    },
  });

  await session.commitMessages({ role: "user", content: "请简短回答。" });
  await engine.run(session);

  const eventTypes = events.map((event) => event.type);
  const thinkingIndex = eventTypes.indexOf("assistant.thinking");
  const providerIndex = eventTypes.indexOf("provider.generate");
  assert.notEqual(thinkingIndex, -1, "Desktop must expose an inference-in-progress state");
  assert.ok(thinkingIndex < providerIndex, "inference state must precede the provider call");
  assert.deepEqual(
    events
      .filter((event) => event.type === "assistant.thinking")
      .map((event) => event.payload?.active),
    [true, false],
  );
  assert.equal(eventTypes.includes("assistant.reasoning.delta"), false);
});

test("Desktop closes the inference state when the provider fails", async (context) => {
  const thinkingStates: unknown[] = [];
  const session = new Session("desktop-thinking-failure", process.cwd(), { persistence: false });
  context.after(() => session.close());
  const reporter = new DesktopReporter({
    runId: "run-thinking-failure",
    sessionId: session.id,
    publish: (event) => {
      if (event.type === "assistant.thinking") thinkingStates.push(event.payload.active);
    },
  });
  const engine = new AgentEngine({
    workDir: process.cwd(),
    registry: new ToolRegistry(),
    reporter,
    provider: {
      async generate() {
        throw new Error("provider unavailable");
      },
    },
  });

  await session.commitMessages({ role: "user", content: "触发失败。" });
  await assert.rejects(engine.run(session), /provider unavailable/u);

  assert.deepEqual(thinkingStates, [true, false]);
});

test("Desktop host uses one stable timeline identity for the inference lifecycle", () => {
  const published: RuntimeNotification[] = [];
  const service = {
    publishDesktopNotification: (notification: RuntimeNotification) => published.push(notification),
    publishEphemeralNotification: () => undefined,
  } as unknown as WorkspaceRuntimeService;
  let resourceVersion = 0;
  const reporter = new DesktopReporter({
    runId: "run-thinking-host",
    sessionId: "session-thinking-host",
    publish: (event) =>
      publishDesktopReporterEvent(service, "/workspace", event, () => ++resourceVersion),
  });

  reporter.onTurnStart(2);
  reporter.onThinking();
  reporter.onThinkingEnd();

  const items = published
    .filter((notification) => notification.topic === "run.timeline")
    .map(
      (notification) =>
        (notification.payload as { readonly item: Readonly<Record<string, unknown>> }).item,
    )
    .filter((item) => item.eventType === "assistant.thinking");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, "status:thinking:run-thinking-host:2");
  assert.equal(items[1]?.id, items[0]?.id);
  assert.deepEqual(
    items.map((item) => (item.data as Readonly<Record<string, unknown>>).active),
    [true, false],
  );

  const thinkingNotifications = published.filter(
    (notification) =>
      notification.topic === "run.timeline" &&
      (notification.payload as { readonly item?: Readonly<Record<string, unknown>> }).item
        ?.eventType === "assistant.thinking",
  );
  const activeTimeline = applyTimelineNotification([], thinkingNotifications[0]!);
  assert.deepEqual(
    activeTimeline.map((item) => ({ title: item.title, state: item.state })),
    [{ title: "Pico 正在推理", state: "active" }],
  );
  assert.deepEqual(applyTimelineNotification(activeTimeline, thinkingNotifications[1]!), []);
});

test("Desktop labels provider-visible reasoning as a summary", () => {
  Object.assign(globalThis, { React });
  const html = renderToStaticMarkup(
    React.createElement(ConversationTranscript, {
      items: [{ id: "thinking-1", kind: "thinking", text: "检查配置。" }],
    }),
  );

  assert.match(html, /aria-label="推理摘要"/u);
  assert.match(html, /推理摘要<\/div>/u);
  assert.doesNotMatch(html, /思考过程/u);
});
