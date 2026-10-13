import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LLMProvider, Message, ToolCall } from "@pico/core";
import { isForegroundProcessFacts } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { resolvePicoPaths } from "@pico/pico-host";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "real production memory_learn confirms canonical executions and a new Pico session uses execution-evidence before its first successful check",
  { timeout: 5 * 60_000 },
  async (t) => {
    const configured = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-production-lesson-real-"));
    const workDir = join(root, "workspace"),
      otherDir = join(root, "other-workspace"),
      picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(otherDir);
    await mkdir(picoHome);
    await writeFile(
      join(workDir, "check.cjs"),
      "const fs=require('fs'); if(!fs.existsSync('ready.flag') || fs.readFileSync('ready.flag','utf8').trim() !== 'READY_TOKEN') { console.error('BuildCheck requires ready.flag containing READY_TOKEN in the checker working directory.'); process.exit(1); } console.log('PASS BuildCheck');",
    );
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const paths = resolvePicoPaths(workDir, { picoHome });
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    const sessions = ["lesson-source", "lesson-reuse"];
    t.after(async () => {
      await lifecycle.close();
      for (const sessionId of sessions)
        await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      events.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const makeCall = (id: string, command: string): ToolCall => ({
      id,
      name: "bash",
      arguments: JSON.stringify({ command }),
    });
    let seed = 0;
    await executeAgentRuntime(
      {
        prompt: "执行 BuildCheck 的受控失败和修复验收。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId: sessions[0]! },
        provider: "openai",
        modelRouteId: "test/test",
        permissionMode: "full-access",
        allowedTools: ["bash"],
      },
      {
        picoHome,
        memoryTrustStore: trust,
        reporter: new SilentReporter(),
        atomicMemoryLifecycle: lifecycle,
        provider: {
          async generate() {
            const toolCalls =
              seed === 0
                ? [makeCall("failed", "node check.cjs")]
                : seed === 1
                  ? [
                      makeCall(
                        "repair",
                        "node -e \"require('fs').writeFileSync('ready.flag','READY_TOKEN')\"",
                      ),
                    ]
                  : [];
            seed++;
            return {
              role: "assistant",
              content: toolCalls.length ? "" : "controlled verification complete",
              ...(toolCalls.length ? { toolCalls } : {}),
            };
          },
        },
      },
    );
    assert.equal((await store.listItems({ workspaceKey: paths.workspace.id })).length, 0);
    const native = (await events.readSession(sessions[0]!)).filter(
      (e) => e.kind === "tool.result.recorded",
    );
    assert.equal(native.length, 2);
    assert.equal(
      native[0]!.kind === "tool.result.recorded" && native[0]!.data.executionFacts?.exitCode,
      1,
    );
    const main = createProvider(configured.provider, configured.config);
    const requests: Message[][] = [];
    const provider = new Proxy(main, {
      get(target, key) {
        if (key === "generate")
          return (...args: Parameters<LLMProvider["generate"]>) => {
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
    const run = (
      prompt: string,
      sessionId: string,
      mode: "new" | "resume",
      allowedTools: string[],
    ) =>
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
          permissionMode: "full-access",
          allowedTools,
        },
        {
          picoHome,
          modelRouter: configured.runtime.router,
          provider,
          memoryTrustStore: trust,
          reporter: new SilentReporter(),
          atomicMemoryLifecycle: lifecycle,
          maxTurns: 10,
          atomicMemoryModelFactory: async () => {
            throw new Error("This test cannot use user-fact extraction");
          },
        },
      );
    await run(
      '完成 BuildCheck 的学习与三次独立验收任务。先基于刚才的实际失败和修复提炼不超过40个英文词的陈述式教训，保留必要文件名、精确标识和适用条件；调用 memory_learn action=propose、taskFamily=BuildCheck、failure={"toolCallId":"failed"}，此时不要带验证引用。候选提出后，执行任务指定的三次独立 Bash 验收，每个工具调用的 command 必须原样为 node check.cjs，不要合并为一个命令。最后调用 memory_learn action=verify、candidateId用提出结果中的真实ID，省略verifications让Host读取刚才的实际结果。不要把执行结果当用户事实；只有confirmed才能确认保存。',
      sessions[0]!,
      "resume",
      ["memory_learn", "bash"],
    );
    const items = await store.listItems({ workspaceKey: paths.workspace.id });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.item.origin, "agent_extracted");
    assert.equal(items[0]!.executionEvidence?.verificationCount, 3);
    assert.equal(items[0]!.sources.length, 4);
    const observed = await events.readSession(sessions[0]!);
    assert.ok(
      items[0]!.sources.every(({ eventId }) =>
        observed.some(
          (event) =>
            event.eventId === eventId &&
            event.kind === "tool.result.recorded" &&
            event.data.toolName === "bash",
        ),
      ),
    );
    // Recreate the previously failing environment; a fresh Session must act on the recalled lesson.
    await rm(join(workDir, "ready.flag"));
    requests.length = 0;
    await run(
      "完成 BuildCheck 验收。依据已有项目记忆，在首次检查前完成必要准备；若需写入文件，使用正式 write_file 工具，再只调用一次 Bash 执行 node check.cjs，成功后简短报告结果。不要先执行检查失败再修复，不读取历史会话。",
      sessions[1]!,
      "new",
      ["bash", "write_file"],
    );
    assert.ok(
      requests.some((messages) =>
        messages.some(({ content }) => content.includes('source="execution-evidence"')),
      ),
    );
    const outcomes = (await events.readSession(sessions[1]!)).filter(
      (e) =>
        e.kind === "tool.result.recorded" &&
        e.data.toolName === "bash" &&
        isForegroundProcessFacts(e.data.executionFacts),
    );
    assert.equal(
      outcomes.length,
      1,
      JSON.stringify({
        lesson: items[0]!.item.content,
        outcomes,
        commands: (await events.readSession(sessions[1]!))
          .filter((e) => e.kind === "tool.started")
          .map((e) => (e.kind === "tool.started" ? e.data.argumentsJson : "")),
      }),
    );
    assert.ok(
      outcomes[0]!.kind === "tool.result.recorded" &&
        outcomes[0]!.data.executionFacts?.exitCode === 0 &&
        outcomes[0]!.data.body.storage === "inline" &&
        outcomes[0]!.data.body.content.includes("PASS BuildCheck"),
      JSON.stringify({
        lesson: items[0]!.item.content,
        outcome: outcomes[0],
        commands: (await events.readSession(sessions[1]!))
          .filter((e) => e.kind === "tool.started")
          .map((e) => (e.kind === "tool.started" ? e.data.argumentsJson : "")),
      }),
    );
    const otherKey = resolvePicoPaths(otherDir, { picoHome }).workspace.id;
    assert.equal(
      (await new AtomicMemoryContextBuilder(store, otherKey).build("BuildCheck")).items.length,
      0,
    );
  },
);
