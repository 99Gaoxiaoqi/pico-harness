import * as React from "react";
import { createElement } from "react";
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from "react-dom/server";
import type { DeepResearchProgress } from "@pico/core/deep-research";
import { DeepResearchProgressView } from "../../../apps/desktop/src/renderer/conversation/DeepResearchPanel.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "@pico/protocol";
import { SqliteDeepResearchStore } from "@pico/storage";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { buildDefaultToolRegistry } from "@pico/pico-host/default-registry";
import { createDeepResearchTools } from "@pico/pico-host/deep-research-tools";
import { buildApprovalMiddleware } from "@pico/pico-host/agent-runtime";
import { ApprovalManager } from "@pico/pico-host/global-approval-manager";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("research mode persists across desktop reload and the real tool pipeline denies mutation even with full-access", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-research-host-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const workspacePath = await realpath(workDir);
  await writeDesktopModelRouting(picoHome);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const makeHost = () =>
    new DesktopRuntimeService({
      runtimeService: new WorkspaceRuntimeService({
        env: { PICO_HOME: picoHome },
        execute: async () => ({ ok: true }),
      }),
      trustStore,
      env: { PICO_HOME: picoHome },
    });
  let desktop = makeHost();
  t.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  const created = (await desktop.handle(
    createRuntimeRequest("session.create", { workspacePath }),
  )) as { session: { sessionId: string } };
  const sessionId = created.session.sessionId;
  const scope = { workspacePath, sessionId };
  const updated = (await desktop.handle(
    createRuntimeRequest("session.settings.update", {
      ...scope,
      collaborationMode: "research",
      permissionMode: "full-access",
    }),
  )) as { settings: { collaborationMode: string } };
  assert.equal(updated.settings.collaborationMode, "research");
  const storageRoot = resolvePicoPaths(workspacePath, { picoHome }).workspace.root;
  const registry = buildDefaultToolRegistry(workspacePath);
  for (const tool of createDeepResearchTools({ storageRoot, sessionId })) registry.register(tool);
  registry.useSafety(
    buildApprovalMiddleware(
      () => assert.fail("research safety may not ask to bypass"),
      workspacePath,
      undefined,
      new ApprovalManager(),
      { sessionId, collaborationMode: "research", permissionMode: "full-access" },
    ),
  );
  for (const [name, args] of [
    ["write_file", { path: "forbidden.txt", content: "no" }],
    ["bash", { command: "touch forbidden.txt" }],
  ] as const) {
    const denied = await registry.execute({ id: name, name, arguments: JSON.stringify(args) });
    assert.equal(denied.isError, true);
    assert.match(denied.output, /Research Mode/);
  }
  const started = await registry.execute({
    id: "start",
    name: "deep_research_start",
    arguments: JSON.stringify({ objective: "检查只读研究" }),
  });
  assert.equal(started.isError, false, started.output);
  await desktop.close();
  desktop = makeHost();
  const restored = (await desktop.handle(createRuntimeRequest("session.settings.get", scope))) as {
    settings: { collaborationMode: string };
  };
  assert.equal(restored.settings.collaborationMode, "research");
  const progress = (await desktop.handle(
    createRuntimeRequest("session.research.query", scope),
  )) as unknown as { run: DeepResearchProgress };
  const rendered = renderToStaticMarkup(
    createElement(DeepResearchProgressView, { run: progress.run }),
  );
  assert.match(rendered, /检查只读研究/);
  assert.match(rendered, /项目入口/);
  assert.match(rendered, /验证证据/);
  assert.equal(progress.run.objective, "检查只读研究");
  assert.equal(progress.run.checklist.length, 4);
  assert.equal(new SqliteDeepResearchStore({ storageRoot }).read(sessionId)?.status, "active");
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.settings.update", { ...scope, orchestrationMode: "swarm" }),
    ),
    /研究模式/,
  );
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.send", {
        ...scope,
        input: { kind: "agent", name: "worker", task: "modify" },
        idempotencyKey: "reject-agent",
      }),
    ),
    /研究模式/,
  );
  await assert.rejects(
    desktop.handle(
      createRuntimeRequest("session.research.query", { ...scope, sessionId: "missing" }),
    ),
  );
  assert.deepEqual(await readdir(workDir), []);
});
