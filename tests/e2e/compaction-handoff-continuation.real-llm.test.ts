/** Real summary + rolling summary + durable restart + actual archive read and result verification. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import type { Message, LLMProvider } from "@pico/core";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { ArchiveReadTool } from "@pico/pico-host/archive-read-tool";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { createProvider } from "@pico/pico-host/provider/factory";
import { FullCompactor } from "@pico/runtime/full-compactor";
import { ToolDisclosure } from "@pico/runtime/tool-disclosure";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { bindToolResultArchiveReader } from "@pico/runtime/tool-result-archive";
import {
  HANDOFF_EVIDENCE_METADATA_KEY,
  isCompactionEvidenceMetadata,
  recordRuntimeCompactionCheckpoint,
} from "@pico/runtime/runtime-compaction-checkpoint";
import { readRuntimeModelHistorySnapshot } from "@pico/runtime/session-runtime-read-model";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";
import {
  checkpointRun,
  createHandoffFixture,
  fixtureTool,
} from "../fixtures/compaction-handoff.js";

const realTest = process.env.RUN_COMPACTION_E2E === "1" ? test : test.skip;
realTest(
  "真实模型滚动压缩重启后读取原始归档、保留禁止动作并完成精确任务",
  { timeout: 600_000 },
  async (t) => {
    const marker = `HANDOFF_${randomUUID().replaceAll("-", "")}`;
    const fixture = await createHandoffFixture("pico-handoff-real-", marker);
    let session = fixture.session;
    t.after(async () => {
      await session.close();
      await rm(fixture.root, { recursive: true, force: true });
    });
    const configured = await configuredUserDefaultRealModel();
    const realProvider = createProvider(configured.provider, {
      ...configured.config,
      sessionId: randomUUID(),
    });
    for (let round = 0; round < 2; round++) {
      const run = await RuntimeRun.start({
        capability: session.runtimeEventCapability!,
        agentSwarmAuthorization: "none",
      });
      await run.run(async () => {
        if (round)
          await run.commitMessages(session, [
            {
              role: "user",
              content:
                "当前环境没有变化。继续原任务，最终格式仍是要求的 JSON；归档读取须在重启后实际完成。",
            },
            { role: "assistant", content: "待重启后核验原始来源，再完成结果。" },
          ]);
        const result = await recordRuntimeCompactionCheckpoint({
          session,
          runtimeRun: checkpointRun(session, run),
          compactor: new FullCompactor({ provider: realProvider, maxAttempts: 1 }),
          request: { trigger: "manual", inputBudgetTokens: 4000, targetRetainedTokens: 1 },
        });
        assert.ok(result, `real compaction round ${round + 1} must commit`);
      });
    }
    const events = await session.runtimeEventStore!.readSession(session.id);
    const checkpoints = events.filter((event) => event.kind === "context.checkpoint.recorded");
    assert.equal(checkpoints.length, 2);
    const last = checkpoints.at(-1)!;
    const metadata = last.data.summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
    assert.ok(isCompactionEvidenceMetadata(metadata));
    const reportRef = metadata.references.find(
      (reference) => reference.eventId === fixture.report.eventId,
    );
    assert.ok(reportRef?.archiveRef, "rolling real summary must retain actual report source");
    assert.equal(last.data.previousCheckpointId, checkpoints[0]!.data.checkpointId);
    const expected = (await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, session.id))
      .messages;
    assert.equal(
      expected.some((message) => message.role === "user" && !message.toolCallId),
      false,
      "acceptance must exercise checkpoint-only task carrier",
    );
    await session.close();
    const runtimePort = createEngineRuntimePort();
    session = new Session(fixture.session.id, fixture.workDir, {
      picoHome: fixture.picoHome,
      runtimePort,
    });
    await session.recover();
    assert.deepEqual(
      (await readRuntimeModelHistorySnapshot(session.runtimeEventStore!, session.id)).messages,
      expected,
    );

    const reader = bindToolResultArchiveReader(session.runtimeEventStore!, session.id);
    let actualReportReads = 0;
    const registry = new ToolRegistry();
    registry.register(
      new ArchiveReadTool({
        read: reader.read,
        readRaw: async (path) => {
          const output = await reader.readRaw(path);
          if (path === reportRef.archiveRef) {
            actualReportReads++;
            assert.equal(output, fixture.rawReport);
          }
          return output;
        },
      }),
    );
    let forbiddenCalls = 0;
    for (const name of ["write_file", "legacy_probe"])
      registry.register(
        fixtureTool(name, async () => {
          forbiddenCalls++;
          throw new Error("Forbidden action attempted");
        }),
      );
    const disclosure = new ToolDisclosure();
    disclosure.setBaselineTools(["archive_read", "write_file", "legacy_probe"]);
    const requests: Message[][] = [];
    const provider: LLMProvider = {
      async generate(messages, tools, options) {
        requests.push(structuredClone(messages));
        return realProvider.generate(messages, tools, options);
      },
    };
    const response = await new AgentEngine({
      provider,
      registry,
      workDir: fixture.workDir,
      runtimePort,
      toolDisclosure: disclosure,
      reporter: new SilentReporter(),
      maxTurns: 5,
      systemPrompt:
        "继续用户尚未完成的任务。遵守用户约束；引用仅说明来源，涉及核验时实际读取原始证据。",
    }).run(session);
    assert.ok(
      requests[0]!.some((message) =>
        message.content.includes('<current-turn-context source="host_projection">'),
      ),
      "fresh request must carry host task context through the genuine assistant checkpoint",
    );
    assert.ok(
      actualReportReads > 0,
      "real continuation must actually invoke archive reader for original report",
    );
    assert.equal(
      forbiddenCalls,
      0,
      "failed approach and write prohibition must survive rolling handoff",
    );
    assert.deepEqual(JSON.parse(response.at(-1)!.content.trim()), { verified_marker: marker });
    const after = await session.runtimeEventStore!.readSession(session.id);
    assert.deepEqual(
      after.slice(0, events.length),
      events,
      "continuation must not rewrite original events/checkpoints",
    );
    assert.ok(
      after.some(
        (event) =>
          event.kind === "tool.result.recorded" &&
          event.data.toolName === "archive_read" &&
          event.data.status === "succeeded",
      ),
    );
  },
);
