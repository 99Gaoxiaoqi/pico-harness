import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LLMProvider, RuntimeToolResultRecordedEvent } from "@pico/core";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { Session } from "@pico/pico-host/session";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "@pico/pico-host/tool-registry-contract";
import {
  resolveCompactionEvidenceReferences,
  type RuntimeCompactionCheckpointRun,
} from "@pico/runtime/runtime-compaction-checkpoint";
import { SilentReporter } from "@pico/runtime/silent-reporter";

export function handoffSummary(
  evidence: string,
  goal = "继续读取报告，验证后给出精确结果。",
): string {
  return `## Goal\n${goal}\n## Progress\n### Done\n已读取报告；旧探测失败。\n### In Progress\n等待重启后读取原始证据。\n## Key Decisions\n继续使用已读取报告的归档，避免重复失败的探测。\n## Constraints\n禁止写文件；环境未变化时不得重复 legacy_probe；完成前须 archive_read 读取原始报告。\n## Next Steps\n读取归档，再给出经过验证的结果。\n## Critical Context\n报告读取来自 read_report；legacy_probe 错误为环境不可用。\n## Evidence\n${evidence}`;
}

export function fixtureTool(name: string, execute: () => Promise<string>): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => name,
    definition: () => ({
      name,
      description: `${name} test fixture.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    execute,
  };
}

export async function createHandoffFixture(prefix: string, marker: string) {
  const root = await mkdtemp(join(process.env.PICO_TEST_TMPDIR ?? tmpdir(), prefix));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workDir, { recursive: true });
  const runtimePort = createEngineRuntimePort();
  const session = new Session("compaction-handoff", workDir, { picoHome, runtimePort });
  await session.recover();
  const rawReport = `REPORT-BEGIN\nverified_marker=${marker}\nREPORT-END`;
  const task =
    "续接验收任务：先读取报告。压缩并重启后，必须通过 archive_read 读取原始报告再完成任务，最终只输出 JSON 对象，字段 verified_marker 等于报告中的精确值。禁止写文件；legacy_probe 已因环境不可用失败，环境未变化时禁止重复该方案。";
  await session.commitMessages({ role: "user", content: task });
  const registry = new ToolRegistry();
  registry.register(fixtureTool("read_report", async () => rawReport));
  registry.register(
    fixtureTool("legacy_probe", async () => {
      throw new Error("环境不可用，禁止无新证据重试。");
    }),
  );
  let calls = 0;
  const seedProvider: LLMProvider = {
    async generate() {
      calls++;
      return calls === 1
        ? {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call:legacy", name: "legacy_probe", arguments: "{}" },
              { id: "call:report", name: "read_report", arguments: "{}" },
            ],
          }
        : { role: "assistant", content: "报告已读取。尚未完成续接核查，后续必须读取原始证据。" };
    },
  };
  await new AgentEngine({
    provider: seedProvider,
    registry,
    workDir,
    runtimePort,
    reporter: new SilentReporter(),
    maxTurns: 2,
  }).run(session);
  // A completed tail allows the next manual fold to cover the entire original tool batch.
  const appendRun = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  await appendRun.run(() =>
    appendRun.commitMessages(session, [
      { role: "user", content: "保存关键决定、禁止动作和证据来源，继续原任务。" },
      { role: "assistant", content: "等待继续执行。" },
    ]),
  );
  const events = await session.runtimeEventStore!.readSession(session.id);
  const report = events.find(
    (event): event is RuntimeToolResultRecordedEvent =>
      event.kind === "tool.result.recorded" && event.data.toolName === "read_report",
  );
  const failed = events.find(
    (event): event is RuntimeToolResultRecordedEvent =>
      event.kind === "tool.result.recorded" && event.data.toolName === "legacy_probe",
  );
  assert.ok(report && failed);
  assert.equal(report.data.status, "succeeded");
  assert.equal(failed.data.status, "failed");
  return { root, workDir, picoHome, session, report, failed, rawReport, task };
}

/** Exercises the public resolver port against real immutable storage entries. */
export function checkpointRun(
  session: Session,
  run: RuntimeRun,
): RuntimeCompactionCheckpointRun<Session> {
  return {
    claimsSession: run.claimsSession.bind(run),
    readModelHistoryEntries: run.readModelHistoryEntries.bind(run),
    findLastCompactionCheckpoint: async () => {
      const last = await run.findLastCompactionCheckpoint();
      if (!last) return undefined;
      const events = await session.runtimeEventStore!.readSession(session.id);
      const event = events.find(
        (candidate) =>
          candidate.kind === "context.checkpoint.recorded" &&
          candidate.data.checkpointId === last.checkpointId,
      );
      const format =
        event?.kind === "context.checkpoint.recorded"
          ? event.data.summary.providerData?.picoSummaryFormat
          : undefined;
      return {
        ...last,
        ...(format === "sections_v1" || format === "sections_v2" ? { summaryFormat: format } : {}),
      };
    },
    resolveCompactionEvidenceReferences: async (input) =>
      resolveCompactionEvidenceReferences(
        await session.runtimeEventStore!.readSessionEntries(session.id),
        input,
      ),
    recordCheckpoint: run.recordCheckpoint.bind(run),
  };
}
