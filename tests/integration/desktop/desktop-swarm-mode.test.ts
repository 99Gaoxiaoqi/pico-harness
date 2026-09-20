import assert from "node:assert/strict";
import { globalSessionManager } from "@pico/pico-host/session";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeRequest } from "../../../packages/protocol/src/index.js";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { parseDesktopQueuedInputRecord } from "@pico/pico-host";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { renderToStaticMarkup } from "react-dom/server";
import React, { createElement } from "react";
import { ConversationComposerMenu } from "../../../apps/desktop/src/renderer/conversation/ConversationComposerMenu.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("desktop persists Swarm beside Plan and delivers a single-turn override without changing defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-swarm-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspace);
  await mkdir(picoHome);
  await writeDesktopModelRouting(picoHome);
  const canonical = await realpath(workspace);
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const deliveries: Array<string | undefined> = [];
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async (input) => {
      deliveries.push(input.execution?.orchestrationMode);
      return { ok: true };
    },
  });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  try {
    const created = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    const scope = { workspacePath: canonical, sessionId: created.session.sessionId };
    const settings = (await desktop.handle(
      createRuntimeRequest("session.settings.update", {
        ...scope,
        orchestrationMode: "swarm",
        collaborationMode: "plan",
      }),
    )) as { settings: { orchestrationMode: string; collaborationMode: string } };
    assert.equal(settings.settings.orchestrationMode, "swarm");
    assert.equal(settings.settings.collaborationMode, "plan");
    await desktop.handle(
      createRuntimeRequest("session.settings.update", {
        ...scope,
        orchestrationMode: "default",
        collaborationMode: "agent",
      }),
    );
    await desktop.handle(
      createRuntimeRequest("session.send", {
        ...scope,
        input: { kind: "text", text: "Read only", orchestrationMode: "swarm" },
        idempotencyKey: "one-turn-swarm",
      }),
    );
    for (let attempt = 0; attempt < 50 && !deliveries.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(deliveries, ["swarm"]);
    assert.equal(
      parseDesktopQueuedInputRecord({
        kind: "text",
        text: "Queued task",
        orchestrationMode: "swarm",
      }).orchestrationMode,
      "swarm",
    );
    const after = (await desktop.handle(createRuntimeRequest("session.settings.get", scope))) as {
      settings: { orchestrationMode: string };
    };
    assert.equal(after.settings.orchestrationMode, "default");
    Object.assign(globalThis, { React });
    const html = renderToStaticMarkup(
      createElement(ConversationComposerMenu, {
        modes: {
          planActive: true,
          graphActive: false,
          swarmActive: true,
          onPlanChange() {},
          onGraphChange() {},
          onSwarmChange() {},
        },
      }),
    );
    assert.match(html, /Swarm/u);
    assert.match(html, /aria-checked="true"[^>]*title="并行处理独立任务/u);
    assert.match(html, /退出 Swarm|关闭 Swarm/u);
  } finally {
    await desktop.close();
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});
