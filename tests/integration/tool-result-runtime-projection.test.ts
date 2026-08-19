import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EvidenceArchive,
  formatEvidenceUri,
  parseEvidenceUri,
} from "../../src/context/evidence-archive.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { Session } from "../../src/engine/session.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/storage/runtime-event.js";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../../src/tools/delegation-registry.js";
import { ReadEvidenceTool } from "../../src/tools/evidence-read.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

const LARGE_TOOL_NAME = "large_fixture";
const LARGE_TOOL_CALL_ID = "call:large-fixture";
const READ_EVIDENCE_CALL_ID = "call:read-evidence";

test("large Runtime ToolResult persists one Evidence fact and replays its bounded projection", async (context) => {
  const sessionId = "runtime-tool-result-evidence";
  const fixture = await createFixture("pico-runtime-tool-result-evidence-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const canary = "PICO_MIDDLE_CANARY_ONLY_IN_RAW_EVIDENCE";
  const rawOutput = buildLargeOutput(canary);
  const rawSizeBytes = Buffer.byteLength(rawOutput, "utf8");
  const rawSha256 = sha256(rawOutput);
  const canaryOffsetBytes = Buffer.byteLength(
    rawOutput.slice(0, rawOutput.indexOf(canary)),
    "utf8",
  );
  const evidenceArchive = new EvidenceArchive({
    baseDir: fixture.paths.workspace.evidence,
  });
  const registry = new ToolRegistry();
  registry.register(outputTool(LARGE_TOOL_NAME, rawOutput));
  registry.register(new ReadEvidenceTool(fixture.workDir, fixture.paths.workspace.evidence));

  const providerMessages: Message[][] = [];
  let ledgerBeforeReadback: string | undefined;
  const provider: LLMProvider = {
    async generate(messages, availableTools) {
      providerMessages.push(structuredClone(messages));
      if (providerMessages.length === 1) {
        assert.ok(availableTools.some((tool) => tool.name === LARGE_TOOL_NAME));
        assert.ok(availableTools.some((tool) => tool.name === "read_evidence"));
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: LARGE_TOOL_CALL_ID,
              name: LARGE_TOOL_NAME,
              arguments: "{}",
            },
          ],
        };
      }
      if (providerMessages.length === 2) {
        const projected = messages.find((message) => message.toolCallId === LARGE_TOOL_CALL_ID);
        assert.ok(projected, "second Provider request must contain the large ToolResult");
        const evidenceUri = projected.content.match(
          /pico:\/\/evidence\/[^\s"]+\/[a-f0-9]{64}/u,
        )?.[0];
        assert.ok(evidenceUri, "large ToolResult projection must expose an Evidence URI");
        // SQLite 纪元:断言对象从 session.jsonl 换成 runtime_events 物化载荷。
        const ledgerStore = new SqliteRuntimeEventStore({
          storageRoot: fixture.paths.workspace.root,
        });
        try {
          ledgerBeforeReadback = JSON.stringify(await ledgerStore.readSession(sessionId));
        } finally {
          ledgerStore.close();
        }
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: READ_EVIDENCE_CALL_ID,
              name: "read_evidence",
              arguments: JSON.stringify({
                ref: evidenceUri,
                offsetBytes: canaryOffsetBytes,
                limitBytes: 256,
              }),
            },
          ],
        };
      }
      if (providerMessages.length === 3) {
        const readback = messages.find((message) => message.toolCallId === READ_EVIDENCE_CALL_ID);
        assert.match(readback?.content ?? "", new RegExp(canary, "u"));
        return { role: "assistant", content: "done" };
      }
      throw new Error("unexpected Provider turn");
    },
  };
  const runtimePort = createEngineRuntimePort();
  const session = new Session(sessionId, fixture.workDir, {
    persistence: true,
    picoHome: fixture.picoHome,
    runtimePort,
  });
  fixture.activeSession = session;
  await session.recover();
  await session.commitMessages({ role: "user", content: "Run the fixture." });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: fixture.workDir,
    runtimePort,
    runtimeEvidenceArchive: evidenceArchive,
    reporter: new SilentReporter(),
    maxTurns: 4,
  });

  await engine.run(session);

  assert.equal(providerMessages.length, 3);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const toolResults = events.filter(
    (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
  );
  assert.equal(toolResults.length, 2);
  const largeResult = requireToolResult(toolResults, LARGE_TOOL_CALL_ID);
  assert.equal(largeResult.data.status, "succeeded");
  assert.equal(largeResult.data.body.storage, "evidence");
  assert.equal(largeResult.data.body.sha256, rawSha256);
  assert.equal(largeResult.data.body.sizeBytes, rawSizeBytes);
  assert.equal("content" in largeResult.data.body, false);
  assert.equal(largeResult.data.projection.mode, "preview");
  assert.equal(largeResult.data.projection.truncated, true);
  assert.ok(largeResult.data.projection.text.length <= 1_600);
  assert.match(largeResult.data.projection.text, /HEAD_BOUNDARY/u);
  assert.match(largeResult.data.projection.text, /TAIL_BOUNDARY/u);
  assert.doesNotMatch(largeResult.data.projection.text, new RegExp(canary, "u"));
  assert.ok(largeResult.refs.evidence);

  const evidenceRef = largeResult.refs.evidence;
  const evidenceUri = formatEvidenceUri(evidenceRef);
  const secondProviderResult = providerMessages[1]?.find(
    (message) => message.toolCallId === LARGE_TOOL_CALL_ID,
  );
  assert.ok(secondProviderResult);
  assert.match(secondProviderResult.content, /HEAD_BOUNDARY/u);
  assert.match(secondProviderResult.content, /TAIL_BOUNDARY/u);
  assert.match(secondProviderResult.content, new RegExp(escapeRegExp(evidenceUri), "u"));
  assert.doesNotMatch(secondProviderResult.content, new RegExp(canary, "u"));
  assert.ok(secondProviderResult.content.length < 4_000);
  assert.equal(secondProviderResult.providerData, undefined);

  assert.ok(ledgerBeforeReadback);
  assert.doesNotMatch(ledgerBeforeReadback, new RegExp(canary, "u"));
  assert.equal(ledgerBeforeReadback.includes(rawOutput), false);

  const manifest = await evidenceArchive.readRuntimeToolExchange(evidenceRef);
  assert.equal(manifest.schemaVersion, 2);
  if (manifest.schemaVersion !== 2) assert.fail("expected Runtime Evidence v2");
  assert.equal(manifest.content.rawOutput.digest, rawSha256);
  assert.equal(manifest.content.rawOutput.sizeBytes, rawSizeBytes);
  assert.equal(await evidenceArchive.readRuntimeToolOutput(evidenceRef), rawOutput);
  // 票 08 起 manifest 行在 pico.sqlite(evidence_records);明文 canary 不得进清单正文。
  const serializedManifest = JSON.stringify(manifest);
  assert.doesNotMatch(serializedManifest, new RegExp(canary, "u"));
  const blobPath = join(
    fixture.paths.workspace.evidence,
    "blobs",
    "sha256",
    rawSha256.slice(0, 2),
    rawSha256,
  );
  assert.equal(await readFile(blobPath, "utf8"), rawOutput);

  const readbackResult = requireToolResult(toolResults, READ_EVIDENCE_CALL_ID);
  assert.equal(readbackResult.refs.evidence, undefined);
  assert.equal(readbackResult.data.body.storage, "inline");
  if (readbackResult.data.body.storage !== "inline") {
    assert.fail("read_evidence output must remain inline");
  }
  assert.match(readbackResult.data.body.content, new RegExp(canary, "u"));
  assert.equal(readbackResult.data.projection.mode, "full");
  assert.equal(readbackResult.data.projection.strategy, "bounded-readback");
  assert.equal(readbackResult.data.projection.truncated, false);

  const expectedReplay = structuredClone(session.getModelContext());
  await session.close();
  fixture.activeSession = undefined;
  const recovered = new Session(session.id, fixture.workDir, {
    persistence: true,
    picoHome: fixture.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  fixture.activeSession = recovered;
  await recovered.recover();
  assert.deepEqual(recovered.getModelContext(), expectedReplay);
  const replayedLargeResult = recovered
    .getModelContext()
    .find((message) => message.toolCallId === LARGE_TOOL_CALL_ID);
  assert.deepEqual(replayedLargeResult, secondProviderResult);
});

test("Evidence ENOSPC keeps one complete inline fact but a bounded model projection", async (context) => {
  const sessionId = "runtime-tool-result-fail-open";
  const fixture = await createFixture("pico-runtime-tool-result-fail-open-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const canary = "PICO_FAIL_OPEN_MIDDLE_CANARY";
  const rawOutput = buildLargeOutput(canary);
  const registry = new ToolRegistry();
  registry.register(outputTool("fail_open_fixture", rawOutput));
  const providerMessages: Message[][] = [];
  const provider: LLMProvider = {
    async generate(messages) {
      providerMessages.push(structuredClone(messages));
      if (providerMessages.length === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:fail-open",
              name: "fail_open_fixture",
              arguments: "{}",
            },
          ],
        };
      }
      if (providerMessages.length === 2) {
        return { role: "assistant", content: "done" };
      }
      throw new Error("unexpected Provider turn");
    },
  };
  const runtimePort = createEngineRuntimePort();
  const session = new Session(sessionId, fixture.workDir, {
    persistence: true,
    picoHome: fixture.picoHome,
    runtimePort,
  });
  fixture.activeSession = session;
  await session.recover();
  await session.commitMessages({ role: "user", content: "Run the fail-open fixture." });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: fixture.workDir,
    runtimePort,
    runtimeEvidenceArchive: new EnospcEvidenceArchive({
      baseDir: fixture.paths.workspace.evidence,
    }),
    reporter: new SilentReporter(),
    maxTurns: 3,
  });

  await engine.run(session);

  assert.equal(providerMessages.length, 2);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const result = requireToolResult(
    events.filter(
      (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
    ),
    "call:fail-open",
  );
  assert.equal(result.refs.evidence, undefined);
  assert.equal(result.data.status, "succeeded");
  assert.equal(result.data.body.storage, "inline");
  if (result.data.body.storage !== "inline") {
    assert.fail("fail-open ToolResult must be inline");
  }
  assert.equal(result.data.body.content, rawOutput);
  assert.equal(result.data.body.sha256, sha256(rawOutput));
  assert.equal(result.data.body.sizeBytes, Buffer.byteLength(rawOutput, "utf8"));
  assert.equal(result.data.projection.mode, "preview");
  assert.equal(result.data.projection.truncated, true);
  assert.equal(result.data.projection.text.includes(canary), false);
  assert.match(result.data.projection.strategy, /evidence-write-failed/u);

  const secondProviderResult = providerMessages[1]?.find(
    (message) => message.toolCallId === "call:fail-open",
  );
  assert.ok(secondProviderResult);
  assert.equal(secondProviderResult.content, result.data.projection.text);
  assert.equal(secondProviderResult.content.includes(canary), false);
  const terminal = events.find(
    (event) => event.kind === "run.terminal" && event.runId === result.runId,
  );
  assert.ok(terminal?.kind === "run.terminal");
  assert.equal(terminal.data.status, "completed");
});

test("subagent Runtime preserves complete raw ToolResult before transcript Evidence projection", async (context) => {
  const sessionId = "runtime-subagent-tool-result-evidence";
  const fixture = await createFixture("pico-runtime-subagent-tool-result-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const toolName = "subagent_large_fixture";
  const toolCallId = "call:subagent-large-fixture";
  const canary = "PICO_SUBAGENT_MIDDLE_CANARY_ONLY_IN_RAW_EVIDENCE";
  const rawOutput = buildLargeOutput(canary);
  assert.ok(rawOutput.length > 8_000);
  const evidenceArchive = new EvidenceArchive({
    baseDir: fixture.paths.workspace.evidence,
  });
  const providerMessages: Message[][] = [];
  const fullReport =
    "已完成子代理大型工具结果核验，原始证据保持完整且模型上下文仅接收有界投影。\n".repeat(120);
  const provider: LLMProvider = {
    async generate(messages, availableTools) {
      providerMessages.push(structuredClone(messages));
      if (providerMessages.length === 1) {
        assert.ok(availableTools.some((tool) => tool.name === toolName));
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: toolCallId, name: toolName, arguments: "{}" }],
        };
      }
      if (providerMessages.length === 2) {
        const projected = messages.find((message) => message.toolCallId === toolCallId);
        assert.ok(projected);
        assert.match(projected.content, /pico:\/\/evidence\/[^\s"]+\/[a-f0-9]{64}/u);
        assert.doesNotMatch(projected.content, new RegExp(canary, "u"));
        return { role: "assistant", content: fullReport };
      }
      throw new Error("unexpected subagent Provider turn");
    },
  };
  const runtimePort = createEngineRuntimePort();
  const session = new Session(sessionId, fixture.workDir, {
    persistence: true,
    picoHome: fixture.picoHome,
    runtimePort,
  });
  fixture.activeSession = session;
  await session.recover();
  const engine = new AgentEngine({
    provider,
    registry: new ToolRegistry(),
    workDir: fixture.workDir,
    runtimePort,
    runtimeEvidenceArchive: evidenceArchive,
    subagentReportEvidenceWriter: async (input) =>
      formatEvidenceUri(
        await evidenceArchive.archiveSubagentReport({
          sessionId,
          taskPrompt: input.taskPrompt,
          report: input.report,
          status: input.status,
        }),
      ),
    reporter: new SilentReporter(),
  });
  const subagentRegistry = createSubagentRegistryFactory({
    workDir: fixture.workDir,
    runner: engine,
    manager: new DelegationManager(),
    evidenceBaseDir: fixture.paths.workspace.evidence,
  })({
    mode: "explore",
    role: "leaf",
    depth: 0,
    maxSpawnDepth: 0,
  });
  subagentRegistry.register(outputTool(toolName, rawOutput));

  const parentRun = await runtimePort.startRun({
    capability: session.runtimeEventCapability!,
  });
  const result = await parentRun.run(() =>
    engine.runSub("核验大型工具输出。", subagentRegistry, new SilentReporter(), {
      maxTurns: 3,
      workDir: fixture.workDir,
    }),
  );

  assert.equal(result.status, "completed");
  assert.ok(result.summary.length <= 2_000);
  assert.match(result.summary, /\[完整子代理报告已归档为 Evidence\]/u);
  assert.equal(result.evidenceRefs.length, 1);
  const reportReference = {
    ...parseEvidenceUri(result.evidenceRefs[0]!),
    kind: "subagent-report" as const,
  };
  assert.equal(await evidenceArchive.readSubagentReport(reportReference), fullReport);
  assert.equal(providerMessages.length, 2);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const recorded = requireToolResult(
    events.filter(
      (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
    ),
    toolCallId,
  );
  assert.equal(recorded.visibility, "transcript");
  assert.equal(recorded.data.body.storage, "evidence");
  assert.equal(recorded.data.body.sha256, sha256(rawOutput));
  assert.equal(recorded.data.body.sizeBytes, Buffer.byteLength(rawOutput, "utf8"));
  assert.equal(recorded.data.projection.mode, "preview");
  assert.doesNotMatch(recorded.data.projection.text, new RegExp(canary, "u"));
  assert.ok(recorded.refs.evidence);
  assert.equal(await evidenceArchive.readRuntimeToolOutput(recorded.refs.evidence), rawOutput);
  assert.deepEqual(session.getModelContext(), []);
});

interface RuntimeFixture {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly paths: ReturnType<typeof resolvePicoPaths>;
  activeSession?: Session;
}

async function createFixture(prefix: string): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  const paths = resolvePicoPaths(workDir, { picoHome });
  return {
    root,
    workDir,
    picoHome,
    paths,
  };
}

class EnospcEvidenceArchive extends EvidenceArchive {
  override async archiveRuntimeToolResult(): Promise<never> {
    throw enospc();
  }
}

function enospc(): NodeJS.ErrnoException {
  const error = new Error("fixture Evidence volume is full") as NodeJS.ErrnoException;
  error.code = "ENOSPC";
  return error;
}

function outputTool(name: string, output: string): BaseTool {
  return {
    readOnly: true,
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    name: () => name,
    definition: () => ({
      name,
      description: "Returns one deterministic large UTF-8 fixture.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }),
    async execute() {
      return output;
    },
  };
}

function requireToolResult(
  events: readonly RuntimeToolResultRecordedEvent[],
  toolCallId: string,
): RuntimeToolResultRecordedEvent {
  const event = events.find((candidate) => candidate.refs.toolCallId === toolCallId);
  assert.ok(event, `missing tool.result.recorded for ${toolCallId}`);
  return event;
}

function buildLargeOutput(canary: string): string {
  const rows = Array.from(
    { length: 1_300 },
    (_, index) => `ROW-${index.toString().padStart(4, "0")}-UTF8-数据-abcdefghijklmno`,
  );
  rows[Math.floor(rows.length / 2)] = canary;
  return `HEAD_BOUNDARY\n${rows.join("\n")}\nTAIL_BOUNDARY`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
