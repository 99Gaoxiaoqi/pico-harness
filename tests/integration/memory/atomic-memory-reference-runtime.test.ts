import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { AtomicMemoryRuntime } from "@pico/pico-host/atomic-memory-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { resolvePicoPaths } from "@pico/pico-host";
import type { LLMProvider } from "@pico/core";
import { createHookManagementCommands } from "@pico/cli/hook-management-commands";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { createSessionRuntime } from "@pico/pico-host/session-runtime";

test("Runtime saves a host-bound preceding reply exactly once, exposes ambiguity and never resurrects a deleted note", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-reference-runtime-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "reference-runtime";
  await mkdir(workDir);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(workDir));
  const lifecycle = new AtomicMemoryLifecycle();
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const workspaceKey = resolvePicoPaths(workDir, { picoHome }).workspace.id;
  await store.updateSettings({ workspaceKey, expectedVersion: 1, autoExtract: false });
  t.after(async () => {
    await lifecycle.close();
    store.close();
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    await rm(root, { recursive: true, force: true });
  });
  let modelAcquisitions = 0;
  const run = async (
    prompt: string,
    mode: "new" | "resume",
    provider: LLMProvider,
    desktopInput = false,
  ) => {
    let runtimeState: Awaited<ReturnType<typeof createSessionRuntime>> | undefined;
    if (desktopInput) {
      const sessionLease = await globalSessionManager.getOrCreatePinned(sessionId, workDir, {
        picoHome,
        persistence: true,
        runtimePort: createEngineRuntimePort(),
      });
      const session = sessionLease.session;
      runtimeState = await createSessionRuntime({
        hookCommandFactory: createHookManagementCommands,
        session,
        sessionLease,
        hooks: false,
        lspServers: [],
      });
      await session.commitMessageOnce("desktop-note-input", {
        role: "user",
        content: prompt,
        providerData: { picoKind: "desktop_user_input", picoDesktopInputId: "desktop-note-input" },
      });
    }
    try {
      return await executeAgentRuntime(
        {
          prompt,
          dir: workDir,
          sessionSelection: { mode, sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          allowedTools: ["memory_remember"],
        },
        {
          picoHome,
          provider,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          reporter: new SilentReporter(),
          resumeExistingSession: desktopInput,
          ...(runtimeState ? { runtimeState } : {}),
          atomicMemoryModelFactory: async () => {
            modelAcquisitions++;
            throw new Error("local reference notes must not acquire a model");
          },
        },
      );
    } finally {
      await runtimeState?.dispose();
    }
  };
  const body =
    "pico-harness 使用 RuntimeEvent 作为事实源，CLI/Desktop/Mobile/Remote 复用同一套 Runtime。验收标识是 RuntimeNote907。";
  await run("说明核心架构", "new", {
    generate: async () => ({ role: "assistant", content: body }),
  });
  let calls = 0;
  await run("记一下", "resume", {
    async generate(messages) {
      if (calls++ < 2) {
        if (calls === 2)
          assert.match(
            messages.findLast((message) => message.toolCallId)?.content ?? "",
            /"status":"remembered"/u,
          );
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `remember-${calls}`, name: "memory_remember", arguments: "{}" }],
        };
      }
      assert.match(
        messages.findLast((message) => message.toolCallId)?.content ?? "",
        /RuntimeNote907/u,
      );
      return { role: "assistant", content: "已保存。" };
    },
  });
  const notes = await store.listItems({ workspaceKey });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.item.kind, "note");
  assert.equal(notes[0]!.sources.length, 2);
  await store.deleteItem({
    itemId: notes[0]!.item.itemId,
    expectedVersion: 1,
    operationId: "delete-reference",
  });
  const replay = new AtomicMemoryRuntime({
    workDir,
    picoHome,
    sessionId,
    supported: true,
    gate: async () => ({ allowed: true }),
    modelFactory: async () => {
      modelAcquisitions++;
      throw new Error("replay cannot call a model");
    },
  });
  await replay.capture([], []);
  const replayed = await replay.remember();
  assert.equal(replayed.status, "not_applicable");
  assert.equal((await store.listItems({ workspaceKey })).length, 0);
  let settings = await store.readSettings(workspaceKey);
  await store.updateSettings({ workspaceKey, expectedVersion: settings.version, enabled: false });
  await replay.capture([], []);
  const disabled = await replay.remember();
  assert.equal(disabled.status, "unavailable");
  if (disabled.status === "unavailable") assert.equal(disabled.reason, "memory_disabled");
  settings = await store.readSettings(workspaceKey);
  await store.updateSettings({ workspaceKey, expectedVersion: settings.version, enabled: true });
  let ambiguityCalls = 0;
  await run("把之前那个记下来", "resume", {
    async generate(messages) {
      if (ambiguityCalls++ === 0)
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "ambiguous", name: "memory_remember", arguments: "{}" }],
        };
      const error = messages.findLast((message) => message.toolCallId)?.content ?? "";
      assert.match(error, /reference_ambiguous/u);
      assert.match(error, /未保存/u);
      return { role: "assistant", content: "请明确要保存哪条回复。" };
    },
  });
  assert.equal((await store.listItems({ workspaceKey })).length, 0);
  await run("说明桌面输入架构", "resume", {
    generate: async () => ({
      role: "assistant",
      content: "桌面输入由宿主绑定到真实对话执行，验收标识为 DesktopNote730。",
    }),
  });
  let desktopCalls = 0;
  await run(
    "记一下",
    "resume",
    {
      async generate(messages) {
        if (desktopCalls++ === 0)
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "desktop-remember", name: "memory_remember", arguments: "{}" }],
          };
        assert.match(
          messages.findLast((message) => message.toolCallId)?.content ?? "",
          /DesktopNote730/u,
        );
        return { role: "assistant", content: "桌面笔记已保存。" };
      },
    },
    true,
  );
  const desktopNotes = await store.listItems({ workspaceKey });
  assert.equal(desktopNotes.length, 1);
  assert.ok(desktopNotes[0]!.item.content.includes("DesktopNote730"));
  assert.equal(modelAcquisitions, 0);
});
