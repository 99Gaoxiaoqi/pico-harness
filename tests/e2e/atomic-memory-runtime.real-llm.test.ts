import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { LLMProvider, Message } from "@pico/core";
import { AtomicMemoryContextBuilder, AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { ProviderAtomicMemoryModel } from "@pico/pico-host/atomic-memory-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "real Runtime automatically saves a preference and recalls an explicitly saved assistant note in a new session",
  { timeout: 5 * 60_000 },
  async (t) => {
    const configured = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-memory-runtime-real-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home");
    await mkdir(workDir, { recursive: true });
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const paths = resolvePicoPaths(workDir, { picoHome });
    const sessions = ["memory-real-save", "memory-real-recall"];
    t.after(async () => {
      await lifecycle.close();
      store.close();
      for (const sessionId of sessions)
        await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    const main = createProvider(configured.provider, configured.config);
    const requests: Message[][] = [];
    const provider = new Proxy(main, {
      get(target, key) {
        if (key === "generate")
          return async (...args: Parameters<LLMProvider["generate"]>) => {
            requests.push(structuredClone(args[0]));
            return target.generate(...args);
          };
        if (key === "generateStream" && target.generateStream)
          return (...args: Parameters<NonNullable<LLMProvider["generateStream"]>>) => {
            requests.push(structuredClone(args[0]));
            return target.generateStream!(...args);
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const auxiliary = new ProviderAtomicMemoryModel(
      createProvider(configured.provider, configured.config),
    );
    let auxiliaryCalls = 0;
    const run = (prompt: string, sessionId: string, mode: "new" | "resume") =>
      executeAgentRuntime(
        {
          prompt,
          dir: workDir,
          sessionSelection: { mode, sessionId },
          provider: configured.provider,
          modelRouteId: configured.route.id,
          baseURL: configured.config.baseURL,
          apiKey: configured.config.apiKey,
          model: configured.config.model,
          modelCapabilities: configured.route.capabilities,
          allowedTools: ["memory_remember", "memory_extract"],
        },
        {
          picoHome,
          modelRouter: configured.runtime.router,
          provider,
          reporter: new SilentReporter(),
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          atomicMemoryModelFactory: async () => ({
            model: {
              call: async (request) => {
                auxiliaryCalls++;
                return auxiliary.call(request);
              },
            },
          }),
        },
      );
    await run(
      "我的长期偏好：在所有工作区我都更喜欢简洁的中文回答。请只回复收到，无需调用工具。",
      sessions[0]!,
      "new",
    );
    const deadline = Date.now() + 90_000;
    while (
      !(await store.listItems({ workspaceKey: paths.workspace.id })).some(
        ({ item }) => item.kind === "preference",
      )
    ) {
      assert.ok(Date.now() < deadline, "automatic preference extraction did not commit");
      await delay(100);
    }
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    try {
      assert.equal(
        (await events.readSession(sessions[0]!)).some(
          (event) => event.kind === "tool.started" && event.data.toolName === "memory_extract",
        ),
        false,
      );
    } finally {
      events.close();
    }
    const settings = await store.readSettings(paths.workspace.id);
    await store.updateSettings({
      workspaceKey: paths.workspace.id,
      expectedVersion: settings.version,
      autoExtract: false,
    });
    const marker = "RecallMarker72841";
    const plan = await run(
      `给测试项目写两条验收步骤。第一条原样包含标识 ${marker}，第二条要求删除后不能复活。只写这两条，不调用工具。`,
      sessions[0]!,
      "resume",
    );
    assert.ok(plan.finalMessage.includes(marker));
    const callsBeforeNote = auxiliaryCalls;
    await run("记一下", sessions[0]!, "resume");
    const notes = (await store.listItems({ workspaceKey: paths.workspace.id })).filter(
      ({ item }) => item.kind === "note",
    );
    assert.ok(
      notes.some(({ item }) => item.content.includes(marker)),
      "explicit short request did not save the preceding reply",
    );
    assert.ok(
      notes.every(
        ({ item, sources }) =>
          item.origin === "user_requested" &&
          item.scopeType === "workspace" &&
          sources.length === 2,
      ),
    );
    assert.equal(
      auxiliaryCalls,
      callsBeforeNote,
      "reference-note saving must not require auxiliary model inference",
    );
    const requestStart = requests.length;
    const recallQuery =
      "项目第一条验收步骤中 RecallMarker 的完整标识是什么？只依据记忆输出完整标识；未知就输出 UNKNOWN。";
    const expectedContext = await new AtomicMemoryContextBuilder(store, paths.workspace.id).build(
      recallQuery,
    );
    const recalled = await run(recallQuery, sessions[1]!, "new");
    assert.ok(
      requests
        .slice(requestStart)
        .some((messages) =>
          messages.some(
            (message) =>
              message.role === "user" &&
              message.content.includes("atomic-memory-reference") &&
              message.content.includes(marker),
          ),
        ),
      `new-session provider request must contain the saved note: ${JSON.stringify({
        notes: notes.map(({ item }) => item.content),
        expectedContext: expectedContext.block,
        userRequests: requests
          .slice(requestStart)
          .flatMap((messages) =>
            messages.filter(({ role }) => role === "user").map(({ content }) => content),
          ),
      })}`,
    );
    assert.equal(recalled.finalMessage.trim(), marker);
  },
);
