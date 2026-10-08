import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeMemoryExtractionBoundary } from "@pico/core";
import { memorySessionKey } from "@pico/core/atomic-memory-runtime-contracts";
import { resolvePicoPaths } from "@pico/pico-host";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import {
  AtomicMemoryRuntime,
  ProviderAtomicMemoryModel,
} from "@pico/pico-host/atomic-memory-runtime";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { HookService } from "@pico/pico-host/hooks/service";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { Session } from "@pico/pico-host/session";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const fact = "我偏好简洁的中文回答。";
const item = {
  content: fact,
  kind: "preference",
  statementType: "fact",
  temporalType: "undated",
  eventStartedAt: null,
  eventEndedAt: null,
  scope: "global",
  keys: [{ key: "中文", type: "concept" }],
};
const summary = [
  "## Goal\n完成代码检查。",
  "## Progress\n### Done\n读取上下文。\n### In Progress\n继续检查。",
  "## Key Decisions\n保持原始约束。",
  "## Next Steps\n返回结果。",
  "## Critical Context\n用户偏好简洁的中文回答。",
].join("\n\n");

for (const scenario of ["stable", "delete", "toggle", "admission-failure"] as const) {
  test(`automatic checkpoint keeps its original admission after PostCompact: ${scenario}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-memory-checkpoint-admission-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home"),
      sessionId = "checkpoint-window";
    await mkdir(workDir);
    const paths = resolvePicoPaths(workDir, { picoHome });
    const management = new DesktopAtomicMemoryService({ picoHome, publish: () => undefined });
    const prior = scenario === "delete" ? (await management.create(workDir, fact)).item : undefined;
    const session = new Session(sessionId, workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
    const modelTriggers: string[] = [];
    const runtime = new AtomicMemoryRuntime({
      workDir,
      picoHome,
      sessionId,
      supported: true,
      gate: async () => ({ allowed: true }),
      modelFactory: async () => ({
        model: new ProviderAtomicMemoryModel({
          async generate(messages, _tools, options) {
            const memory = options?.contextFacts?.memory;
            assert.ok(memory);
            modelTriggers.push(memory.trigger);
            if (memory.stage === "canonicalize")
              return {
                role: "assistant",
                content: JSON.stringify({
                  results: [{ candidateId: "candidate_0", status: "accepted", item }],
                }),
              };
            const evidenceText = messages.find((message) =>
              message.content.includes("<memory_evidence>"),
            )?.content;
            const match = evidenceText?.match(
              /<memory_evidence>\n([\s\S]*?)\n<\/memory_evidence>/u,
            );
            assert.ok(match);
            const evidence = JSON.parse(match[1]!) as { sourceRef: string }[];
            const source = evidence.at(-1);
            assert.ok(source);
            assert.ok(messages.some((message) => message.content.includes(fact)));
            const candidate = { ...item, evidence: [{ sourceRef: source.sourceRef, quote: fact }] };
            return {
              role: "assistant",
              content: JSON.stringify({
                status: "complete",
                coverageStatus: "processed",
                requestedStatus: memory.trigger === "remember" ? "resolved" : "not_applicable",
                requestedItems: memory.trigger === "remember" ? [candidate] : [],
                incidentalItems: memory.trigger === "compaction" ? [candidate] : [],
              }),
            };
          },
        }),
      }),
    });
    t.after(async () => {
      await runtime.drain();
      management.close();
      await session.close();
      await rm(root, { recursive: true, force: true });
    });
    await session.recover();
    const registry = new ToolRegistry();
    registry.register({
      name: () => "read_marker",
      readOnly: true,
      definition: () => ({
        name: "read_marker",
        description: "read marker",
        inputSchema: { type: "object", properties: { marker: { type: "integer" } } },
      }),
      execute: async () => "code context " + "x ".repeat(500),
    });
    let mainCalls = 0,
      compactions = 0,
      checkpointThrough = 0;
    let frozenAdmission: RuntimeMemoryExtractionBoundary | undefined;
    const engine = new AgentEngine({
      provider: {
        async generate() {
          mainCalls++;
          if (mainCalls <= 2)
            return {
              role: "assistant",
              content: "继续读取。",
              usage: { promptTokens: mainCalls === 1 ? 100 : 9000, completionTokens: 1000 },
              toolCalls: [
                {
                  id: `read-${mainCalls}`,
                  name: "read_marker",
                  arguments: JSON.stringify({ marker: mainCalls }),
                },
              ],
            };
          return {
            role: "assistant",
            content: "检查完成。",
            usage: { promptTokens: 100, completionTokens: 10 },
          };
        },
      },
      registry,
      workDir,
      runtimePort: createEngineRuntimePort(),
      memoryHooks: {
        capture: (messages, tools) => runtime.capture(messages, tools),
        checkpoint: (checkpointId) => runtime.checkpoint(checkpointId),
        async compactionAdmission() {
          if (scenario === "admission-failure")
            throw new Error("temporary admission reader failure");
          frozenAdmission = await runtime.compactionAdmission();
          return frozenAdmission;
        },
      },
      hookService: new HookService({
        workDir,
        sessionId,
        executor: {
          async execute() {
            return { decision: "allow" };
          },
        },
        decisionProviders: [
          {
            async evaluate(event) {
              if (event !== "PostCompact") return { decision: "allow" };
              const entries = await session.runtimeEventStore!.readSessionEntries(sessionId);
              const checkpoint = entries.find(
                (entry) => entry.event.kind === "context.checkpoint.recorded",
              );
              assert.ok(checkpoint?.event.kind === "context.checkpoint.recorded");
              assert.ok(!entries.some((entry) => entry.event.kind === "run.terminal"));
              const checkpointData = checkpoint.event.data;
              const boundary = checkpointData.memoryExtractionBoundary;
              assert.deepEqual(boundary, {
                runtimeEventId: checkpoint.event.data.throughEventId,
                ...(frozenAdmission ?? { disposition: "policy_denied" }),
              });
              checkpointThrough = entries.find(
                (entry) => entry.event.eventId === checkpointData.throughEventId,
              )!.sequence;
              assert.equal(modelTriggers.length, 0, "admission must precede extraction dispatch");
              const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
              try {
                assert.equal(
                  await store.readExtractionCursor(memorySessionKey(paths.workspace.id, sessionId)),
                  undefined,
                );
                if (prior) {
                  await management.delete(workDir, {
                    workspacePath: workDir,
                    itemId: prior.itemId,
                    expectedVersion: prior.version,
                    idempotencyKey: "delete-after-checkpoint",
                  });
                  assert.equal(await store.readItem(prior.itemId), undefined);
                  assert.notEqual(await store.readDeletionRevision(), boundary?.deletionRevision);
                } else if (scenario === "toggle") {
                  let settings = await store.readSettings(paths.workspace.id);
                  settings = await store.updateSettings({
                    workspaceKey: paths.workspace.id,
                    expectedVersion: settings.version,
                    autoExtract: false,
                  });
                  settings = await store.updateSettings({
                    workspaceKey: paths.workspace.id,
                    expectedVersion: settings.version,
                    autoExtract: true,
                  });
                  assert.notEqual(settings.version, boundary?.settingsVersion);
                }
              } finally {
                store.close();
              }
              return { decision: "allow" };
            },
          },
        ],
      }),
      contextRouteIdentity: "checkpoint-admission-test",
      contextBudget: {
        contextWindowTokens: 10000,
        declaredContextWindowTokens: 10000,
        reservedOutputTokens: 1000,
        safetyMarginTokens: 100,
        inputBudgetTokens: 8900,
      },
      fullCompactor: new FullCompactor({
        provider: {
          async generate() {
            compactions++;
            return { role: "assistant", content: summary };
          },
        },
        maxAttempts: 1,
      }),
      maxTurns: 4,
    });
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      await run.commitMessages(session, [{ role: "user", content: fact + " 请读取代码并检查。" }]);
      await engine.run(session);
      await runtime.drain();
    });
    assert.equal(compactions, 1, "memory admission must not prevent context compaction");
    assert.equal(mainCalls, 3);
    assert.deepEqual(modelTriggers, scenario === "stable" ? ["compaction", "compaction"] : []);
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    try {
      assert.deepEqual(
        (await store.listItems({ workspaceKey: paths.workspace.id })).map(
          ({ item }) => item.content,
        ),
        scenario === "stable" ? [fact] : [],
      );
      assert.equal(
        (await store.readExtractionCursor(memorySessionKey(paths.workspace.id, sessionId)))
          ?.processedOrdinal,
        checkpointThrough,
      );
    } finally {
      store.close();
    }
    if (scenario === "stable") return;
    const rememberRun = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await rememberRun.run(async () => {
      await rememberRun.commitMessages(session, [{ role: "user", content: `请记住：${fact}` }]);
      await runtime.capture(await rememberRun.readModelHistory(), []);
      const remembered = await runtime.remember();
      assert.equal(remembered.status, "remembered");
      assert.deepEqual(
        remembered.requestedItems.map((entry) => entry.content),
        [fact],
      );
    });
    assert.deepEqual(modelTriggers, ["remember", "remember"]);
  });
}
