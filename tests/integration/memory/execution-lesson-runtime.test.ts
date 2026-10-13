import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Message, ToolCall } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { resolvePicoPaths } from "@pico/pico-host";

test(
  "production memory_learn uses settled native events, keeps two votes pending and confirms exactly once after three successes",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-lesson-runtime-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home"),
      sessionId = "native-learning";
    await mkdir(workDir);
    await mkdir(picoHome);
    await writeFile(
      join(workDir, "check.cjs"),
      "if (!require('fs').existsSync('ready.flag')) { console.error('Missing project config ready.flag'); process.exit(1); } console.log('PASS');",
    );
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const key = resolvePicoPaths(workDir, { picoHome }).workspace.id;
    t.after(async () => {
      await lifecycle.close();
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const call = (id: string, name: string, args: object): ToolCall => ({
      id,
      name,
      arguments: JSON.stringify(args),
    });
    const command = "node check.cjs";
    const lookup = (messages: readonly Message[], id: string) => {
      const response = messages.findLast((m) => m.toolCallId === id);
      assert.ok(response, `missing result ${id}`);
      return JSON.parse(response.content) as {
        candidateId: string;
        state: string;
        verificationCount: number;
      };
    };
    let step = 0,
      candidateId = "";
    const run = await executeAgentRuntime(
      {
        prompt: "验证一个项目检查，并保留经过验证的失败教训。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        permissionMode: "full-access",
        allowedTools: ["bash", "memory_learn"],
      },
      {
        picoHome,
        memoryTrustStore: trust,
        atomicMemoryLifecycle: lifecycle,
        reporter: new SilentReporter(),
        provider: {
          async generate(messages) {
            let toolCalls: ToolCall[];
            switch (step++) {
              case 0:
                toolCalls = [call("failed", "bash", { command })];
                break;
              case 1:
                toolCalls = [
                  call("proposal", "memory_learn", {
                    action: "propose",
                    lesson: "BuildCheck expects ready.flag in its working directory.",
                    taskFamily: "BuildCheck",
                    failure: { toolCallId: "failed" },
                  }),
                ];
                break;
              case 2:
                candidateId = lookup(messages, "proposal").candidateId;
                toolCalls = [
                  call("repair", "bash", {
                    command: "node -e \"require('fs').writeFileSync('ready.flag','yes')\"",
                  }),
                ];
                break;
              case 3:
                toolCalls = [call("v1", "bash", { command }), call("v2", "bash", { command })];
                break;
              case 4:
                toolCalls = [
                  call("two-votes", "memory_learn", {
                    action: "verify",
                    candidateId,
                    verifications: [
                      { toolCallId: "v1" },
                      { toolCallId: "v1" },
                      { toolCallId: "v2" },
                    ],
                  }),
                ];
                break;
              case 5:
                assert.equal(lookup(messages, "two-votes").state, "candidate");
                assert.equal((await store.listItems({ workspaceKey: key })).length, 0);
                toolCalls = [call("v3", "bash", { command })];
                break;
              case 6:
                toolCalls = [
                  call("confirm", "memory_learn", {
                    action: "verify",
                    candidateId,
                    verifications: [{ toolCallId: "v3" }],
                  }),
                ];
                break;
              case 7:
                assert.equal(lookup(messages, "confirm").state, "confirmed");
                toolCalls = [
                  call("replay", "memory_learn", {
                    action: "verify",
                    candidateId,
                    verifications: [{ toolCallId: "v3" }],
                  }),
                ];
                break;
              default:
                assert.equal(lookup(messages, "replay").state, "confirmed");
                return { role: "assistant", content: "saved" };
            }
            return { role: "assistant", content: "", toolCalls };
          },
        },
        atomicMemoryModelFactory: async () => {
          throw new Error("No user-fact extraction in this test");
        },
      },
    );
    assert.equal(run.finalMessage, "saved");
    const items = await store.listItems({ workspaceKey: key });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.sources.length, 4);
    assert.equal(items[0]!.executionEvidence?.verificationCount, 3);
    const recalled = await new AtomicMemoryContextBuilder(store, key).build("BuildCheck");
    assert.equal(recalled.references[0]?.source, "execution-evidence");
  },
);

test(
  "production learning refuses a write when its Session owner fence changes after dispatch",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-lesson-owner-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home"),
      sessionId = "lost-owner";
    await mkdir(workDir);
    await mkdir(picoHome);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const path = join(picoHome, "memory.sqlite");
    const store = new SqliteMemoryItemStore(path);
    t.after(async () => {
      await lifecycle.close();
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const isTrusted = trust.isTrusted.bind(trust);
    let advanced = false;
    trust.isTrusted = async (canonical) => {
      const session = globalSessionManager.get(sessionId, workDir, { picoHome });
      const events = session?.runtimeEventStore;
      if (events && !advanced) {
        const slice = await events.readSessionEntriesOfKinds(sessionId, ["tool.started"]);
        if (
          slice.entries.some(
            ({ event }) => event.kind === "tool.started" && event.data.toolName === "memory_learn",
          )
        ) {
          advanced = true;
          const fence = await events.readOwnerFence(sessionId);
          await events.advanceOwnerFence(sessionId, fence.epoch);
        }
      }
      return isTrusted(canonical);
    };
    let step = 0;
    await assert.rejects(
      executeAgentRuntime(
        {
          prompt: "保留一个失败教训。",
          dir: workDir,
          sessionSelection: { mode: "new", sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          permissionMode: "full-access",
          allowedTools: ["bash", "memory_learn"],
        },
        {
          picoHome,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          reporter: new SilentReporter(),
          provider: {
            async generate() {
              const toolCall: ToolCall =
                step++ === 0
                  ? {
                      id: "failed",
                      name: "bash",
                      arguments: JSON.stringify({ command: "node -e 'process.exit(1)'" }),
                    }
                  : {
                      id: "proposal",
                      name: "memory_learn",
                      arguments: JSON.stringify({
                        action: "propose",
                        lesson: "OwnerCheck needs project configuration.",
                        taskFamily: "OwnerCheck",
                        failure: { toolCallId: "failed" },
                      }),
                    };
              return { role: "assistant", content: "", toolCalls: [toolCall] };
            },
          },
          atomicMemoryModelFactory: async () => {
            throw new Error("No user extraction in this test");
          },
        },
      ),
      /owner|fence|lease|uncertain|canonical terminal/i,
    );
    assert.equal(advanced, true);
    assert.equal(
      (
        await store.listItems({
          workspaceKey: resolvePicoPaths(workDir, { picoHome }).workspace.id,
        })
      ).length,
      0,
    );
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM execution_lesson_candidates").get()!.count,
      0,
    );
    db.close();
  },
);
