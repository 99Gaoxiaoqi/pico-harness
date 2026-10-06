import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("外部会话导入要求信任、持久注册且同源并发导入幂等", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-external-import-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const codexHome = join(root, "codex-home");
  const sourceSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const transcriptDirectory = join(codexHome, "sessions", "2026", "10", "07");
  await mkdir(transcriptDirectory, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  await writeFile(
    join(transcriptDirectory, `rollout-${sourceSessionId}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: sourceSessionId, cwd: workspace },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "导入后保留的用户内容" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "导入后保留的助手内容" },
      }),
    ].join("\n") + "\n",
  );

  const env = {
    PICO_HOME: picoHome,
    CODEX_HOME: codexHome,
    PICO_TEST_TOKEN: "test-token",
  };
  const canonicalWorkspace = await realpath(workspace);
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    env,
  });
  let importedSessionId: string | undefined;
  context.after(async () => {
    await desktop.close();
    if (importedSessionId) {
      const cached = globalSessionManager.delete(importedSessionId, canonicalWorkspace, {
        picoHome,
      });
      await cached?.close();
    }
    await rm(root, { recursive: true, force: true });
  });

  const request = createRuntimeRequest("externalSessions.import", {
    adapterId: "codex",
    sourceSessionId,
  });
  await assert.rejects(desktop.handle(request), /工作区尚未信任/u);

  await trustStore.trust(canonicalWorkspace);
  const concurrentImports = await Promise.all([desktop.handle(request), desktop.handle(request)]);
  const imported = concurrentImports[0] as {
    session: { sessionId: string; workspacePath: string };
  };
  const concurrentImport = concurrentImports[1] as {
    session: { sessionId: string; workspacePath: string };
  };
  assert.match(imported.session.sessionId, /^cli-ext-[0-9a-f]{32}$/u);
  importedSessionId = imported.session.sessionId;
  assert.equal(imported.session.workspacePath, canonicalWorkspace);
  assert.deepEqual(concurrentImport.session, imported.session);
  const reimported = (await desktop.handle(request)) as {
    session: { sessionId: string; workspacePath: string };
  };
  assert.deepEqual(reimported.session, imported.session);

  const workspaceResult = (await desktop.handle(createRuntimeRequest("workspace.list", {}))) as {
    workspaces: Array<{ workspacePath: string; registered: boolean }>;
  };
  assert.ok(
    workspaceResult.workspaces.some(
      (entry) => entry.workspacePath === canonicalWorkspace && entry.registered,
    ),
  );
});
