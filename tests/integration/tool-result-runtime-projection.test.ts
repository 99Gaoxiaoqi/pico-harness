import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "../../src/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import { MAX_TOOL_RESULT_BYTES } from "../../src/tools/tool-result-observation.js";

const LARGE_TOOL_NAME = "large_fixture";
const LARGE_TOOL_CALL_ID = "call:large-fixture";

test("large Runtime ToolResult (2048 token < size < 1MB) persists full inline without Evidence", async (context) => {
  const sessionId = "runtime-tool-result-inline";
  const fixture = await createFixture("pico-runtime-tool-result-inline-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const canary = "PICO_MIDDLE_CANARY_ONLY_IN_RAW_OUTPUT";
  const rawOutput = buildLargeOutput(canary);
  const rawSizeBytes = Buffer.byteLength(rawOutput, "utf8");
  const rawSha256 = sha256(rawOutput);
  const registry = new ToolRegistry();
  registry.register(outputTool(LARGE_TOOL_NAME, rawOutput));

  // 渐进披露开启:read_evidence 已随回读协议退役(E3),工具面不披露、不注册。
  const toolDisclosure = new ToolDisclosure();
  toolDisclosure.discloseTools([LARGE_TOOL_NAME]);

  const providerMessages: Message[][] = [];
  const availableToolsByTurn: string[][] = [];
  const provider: LLMProvider = {
    async generate(messages, availableTools) {
      providerMessages.push(structuredClone(messages));
      availableToolsByTurn.push(availableTools.map((tool) => tool.name));
      if (providerMessages.length === 1) {
        assert.ok(availableTools.some((tool) => tool.name === LARGE_TOOL_NAME));
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
      return { role: "assistant", content: "done" };
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
    toolDisclosure,
    reporter: new SilentReporter(),
    maxTurns: 3,
  });

  await engine.run(session);

  assert.equal(providerMessages.length, 2);
  // 验收 4(E3):read_evidence 已退役,工具面永不披露。
  assert.equal(availableToolsByTurn[1]?.includes("read_evidence"), false);
  assert.equal(toolDisclosure.getDisclosedTools().includes("read_evidence"), false);

  // 验收 1:全文 inline 入库,无引用事件。
  const events = await session.runtimeEventStore!.readSession(session.id);
  const toolResults = events.filter(
    (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
  );
  assert.equal(toolResults.length, 1);
  const largeResult = requireToolResult(toolResults, LARGE_TOOL_CALL_ID);
  assert.equal(largeResult.data.status, "succeeded");
  assert.equal(largeResult.refs.evidence, undefined);
  assert.equal(largeResult.data.body.storage, "inline");
  if (largeResult.data.body.storage !== "inline") {
    assert.fail("large ToolResult must stay inline");
  }
  assert.equal(largeResult.data.body.content, rawOutput);
  assert.equal(largeResult.data.body.sha256, rawSha256);
  assert.equal(largeResult.data.body.sizeBytes, rawSizeBytes);
  assert.deepEqual(largeResult.data.projection, {
    version: 1,
    mode: "full",
    text: rawOutput,
    strategy: "original",
    truncated: false,
  });

  // 验收 1:无 blob 写——Evidence blob 目录从未产生。
  assert.equal(existsSync(join(fixture.paths.workspace.evidence, "blobs")), false);

  const ledgerStore = new SqliteRuntimeEventStore({
    storageRoot: fixture.paths.workspace.root,
  });
  let ledger: string;
  try {
    ledger = JSON.stringify(await ledgerStore.readSession(sessionId));
  } finally {
    ledgerStore.close();
  }
  assert.match(ledger, new RegExp(canary, "u"));
  // JSON 转义后的全文(换行 → \n)仍完整在账本里。
  assert.equal(ledger.includes(JSON.stringify(rawOutput).slice(1, -1)), true);

  // Provider 收到的就是全文投影。
  const secondProviderResult = providerMessages[1]?.find(
    (message) => message.toolCallId === LARGE_TOOL_CALL_ID,
  );
  assert.ok(secondProviderResult);
  assert.equal(secondProviderResult.content, rawOutput);
  assert.equal(secondProviderResult.providerData, undefined);

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

test("over-limit Runtime ToolResult (>1MB) is rejected as a synthetic error with refetch guidance", async (context) => {
  const sessionId = "runtime-tool-result-over-limit";
  const fixture = await createFixture("pico-runtime-tool-result-over-limit-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const canary = "PICO_OVER_LIMIT_CANARY_MUST_NOT_PERSIST";
  const rawOutput = `HEAD_BOUNDARY\n${canary}\n${"O".repeat(MAX_TOOL_RESULT_BYTES + 1)}`;
  assert.ok(Buffer.byteLength(rawOutput, "utf8") > MAX_TOOL_RESULT_BYTES);
  const registry = new ToolRegistry();
  registry.register(outputTool("over_limit_fixture", rawOutput));
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
              id: "call:over-limit",
              name: "over_limit_fixture",
              arguments: "{}",
            },
          ],
        };
      }
      return { role: "assistant", content: "done" };
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
  await session.commitMessages({ role: "user", content: "Run the over-limit fixture." });
  const engine = new AgentEngine({
    provider,
    registry,
    workDir: fixture.workDir,
    runtimePort,
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
    "call:over-limit",
  );
  // 验收 2:调用本身照常入账(状态 rejected),模型收到合成错误。
  assert.equal(result.data.status, "rejected");
  assert.equal(result.refs.evidence, undefined);
  assert.equal(result.data.body.storage, "inline");
  if (result.data.body.storage !== "inline") {
    assert.fail("over-limit ToolResult must be an inline synthetic fact");
  }
  const synthetic = result.data.body.content;
  assert.match(synthetic, /输出超限/u);
  assert.match(synthetic, /grep .*head/u);
  assert.match(synthetic, /tail/u);
  assert.match(synthetic, /read_file/u);
  assert.equal(synthetic.includes(canary), false);
  assert.equal(result.data.body.sha256, sha256(synthetic));
  assert.equal(result.data.body.sizeBytes, Buffer.byteLength(synthetic, "utf8"));
  assert.deepEqual(
    { ...result.data.projection, text: "..." },
    {
      version: 1,
      mode: "synthetic",
      text: "...",
      strategy: "output-limit-gate",
      truncated: true,
    },
  );
  assert.equal(result.data.projection.text, synthetic);

  // 原文永久丢弃:全账本不含 canary。
  const ledgerStore = new SqliteRuntimeEventStore({
    storageRoot: fixture.paths.workspace.root,
  });
  let ledger: string;
  try {
    ledger = JSON.stringify(await ledgerStore.readSession(sessionId));
  } finally {
    ledgerStore.close();
  }
  assert.equal(ledger.includes(canary), false);
  assert.equal(existsSync(join(fixture.paths.workspace.evidence, "blobs")), false);

  const secondProviderResult = providerMessages[1]?.find(
    (message) => message.toolCallId === "call:over-limit",
  );
  assert.ok(secondProviderResult);
  assert.equal(secondProviderResult.content, synthetic);

  const terminal = events.find(
    (event) => event.kind === "run.terminal" && event.runId === result.runId,
  );
  assert.ok(terminal?.kind === "run.terminal");
  assert.equal(terminal.data.status, "completed");
});

test("subagent Runtime ToolResult persists full inline before the transcript projection", async (context) => {
  const sessionId = "runtime-subagent-tool-result-inline";
  const fixture = await createFixture("pico-runtime-subagent-tool-result-");
  context.after(async () => {
    await fixture.activeSession?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const toolName = "subagent_large_fixture";
  const toolCallId = "call:subagent-large-fixture";
  const canary = "PICO_SUBAGENT_MIDDLE_CANARY_IN_INLINE_BODY";
  const rawOutput = buildLargeOutput(canary);
  assert.ok(rawOutput.length > 8_000);
  const providerMessages: Message[][] = [];
  const fullReport =
    "已完成子代理大型工具结果核验，原始结果全文 inline 且模型上下文接收完整投影。\n".repeat(120);
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
        assert.equal(projected.content, rawOutput);
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
    reporter: new SilentReporter(),
  });
  const subagentRegistry = createSubagentRegistryFactory({
    workDir: fixture.workDir,
    runner: engine,
    manager: new DelegationManager(),
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
  // 票 E3:报告全文 inline 进 summary/事件,不再外部化为 Evidence 引用。
  assert.ok(result.summary.length > 2_000);
  assert.equal(result.summary, fullReport);
  assert.deepEqual(result.evidenceRefs, []);
  assert.equal(existsSync(join(fixture.paths.workspace.evidence, "blobs")), false);
  assert.equal(providerMessages.length, 2);
  const events = await session.runtimeEventStore!.readSession(session.id);
  const recorded = requireToolResult(
    events.filter(
      (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
    ),
    toolCallId,
  );
  assert.equal(recorded.visibility, "transcript");
  assert.equal(recorded.refs.evidence, undefined);
  assert.equal(recorded.data.body.storage, "inline");
  if (recorded.data.body.storage !== "inline") {
    assert.fail("subagent large ToolResult must be inline");
  }
  assert.equal(recorded.data.body.content, rawOutput);
  assert.equal(recorded.data.body.sha256, sha256(rawOutput));
  assert.equal(recorded.data.body.sizeBytes, Buffer.byteLength(rawOutput, "utf8"));
  assert.equal(recorded.data.projection.mode, "full");
  assert.equal(recorded.data.projection.truncated, false);
  // subagent_report transcript 消息携带全文(E3:报告全文 inline 进事件)。
  const reportMessage = events.find(
    (event) =>
      event.kind === "message.committed" &&
      (event as { data: { message: Message } }).data.message.providerData?.["picoKind"] ===
      "subagent_report",
  ) as unknown as { data: { message: Message } } | undefined;
  assert.ok(reportMessage);
  assert.equal(reportMessage.data.message.content, fullReport);
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
