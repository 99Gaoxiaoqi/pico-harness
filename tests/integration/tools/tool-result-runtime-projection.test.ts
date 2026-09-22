import { currentRuntimeRun } from "@pico/runtime/runtime-run";
import { createSessionForkRuntimePort } from "@pico/pico-host/session-fork-runtime-port-adapter";
import {
  bindToolResultArchiveReader,
  archiveStaleToolResultEntries,
} from "@pico/runtime/tool-result-archive";
import { ReadFileTool } from "@pico/pico-host/read-file-tool";
import { WorkspaceRoots, buildWorkspaceBoundaryMiddleware } from "@pico/pico-host/workspace-roots";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { Session } from "@pico/pico-host/session";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "@pico/pico-host";
import type { LLMProvider } from "@pico/core";
import type { Message } from "@pico/core";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import type { RuntimeToolResultRecordedEvent } from "@pico/core";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "@pico/pico-host/tool-registry-contract";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { ToolDisclosure } from "@pico/runtime/tool-disclosure";
import { MAX_TOOL_RESULT_BYTES } from "@pico/runtime/tool-result-observation";

const LARGE_TOOL_NAME = "large_fixture";
const LARGE_TOOL_CALL_ID = "call:large-fixture";

test("large Runtime ToolResult keeps inline facts, bounds provider projection, and reads pages across restart", async (context) => {
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

  // 由引擎根据实际披露且绑定 reader 的 read_file 开启归档投影。
  const toolDisclosure = new ToolDisclosure();
  toolDisclosure.setBaselineTools([LARGE_TOOL_NAME]);

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
      if (providerMessages.length === 2) {
        const result = messages.find((message) => message.toolCallId === LARGE_TOOL_CALL_ID)!;
        const ref = result.content.match(/pico:\/\/archive\/[^"\s]+/u)?.[0];
        assert.ok(ref);
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call:archive-read",
              name: "read_file",
              arguments: JSON.stringify({
                path: ref,
                offset: rawOutput.indexOf(canary) + 1,
                limit: canary.length,
              }),
            },
          ],
        };
      }
      const run = currentRuntimeRun()!;
      run.setToolResultArchiveAvailable(false);
      assert.equal(
        (await run.readModelHistory()).find((message) => message.toolCallId === LARGE_TOOL_CALL_ID)!
          .content,
        rawOutput,
      );
      run.setToolResultArchiveAvailable(true);
      const page = JSON.parse(
        messages.find((message) => message.toolCallId === "call:archive-read")!.content,
      );
      assert.equal(page.content, canary);
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
  registry.register(
    new ReadFileTool(
      fixture.workDir,
      bindToolResultArchiveReader(session.runtimeEventStore!, session.id),
    ),
  );
  registry.useRequest(buildWorkspaceBoundaryMiddleware(WorkspaceRoots.createSync(fixture.workDir)));
  toolDisclosure.setBaselineTools([LARGE_TOOL_NAME, "read_file"]);
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

  assert.equal(providerMessages.length, 3);
  // 验收 4(E3):read_evidence 已退役,工具面永不披露。
  assert.equal(availableToolsByTurn[1]?.includes("read_evidence"), false);
  assert.equal(toolDisclosure.getDisclosedTools().includes("read_evidence"), false);

  // 验收 1:全文 inline 入库,无引用事件。
  const events = await session.runtimeEventStore!.readSession(session.id);
  const toolResults = events.filter(
    (event): event is RuntimeToolResultRecordedEvent => event.kind === "tool.result.recorded",
  );
  assert.equal(toolResults.length, 2);
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
  assert.equal(largeResult.data.projection.mode, "preview");
  assert.equal(largeResult.data.projection.strategy, "durable-tool-result-archive-v1");
  assert.ok(largeResult.data.projection.text.length < 7500);
  assert.ok(!largeResult.data.projection.text.includes(canary));

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

  // Provider 收到有界投影，并通过 read_file 取回指定原文。
  const secondProviderResult = providerMessages[1]?.find(
    (message) => message.toolCallId === LARGE_TOOL_CALL_ID,
  );
  assert.ok(secondProviderResult);
  assert.equal(secondProviderResult.content, largeResult.data.projection.text);
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
  const ref = secondProviderResult.content.match(/pico:\/\/archive\/[^"\s]+/u)![0];
  const reader = bindToolResultArchiveReader(recovered.runtimeEventStore!, recovered.id);
  let reconstructed = "";
  let offset: number | null = 1;
  while (offset !== null) {
    const encoded = await reader.read(ref, offset, 1000);
    assert.ok(encoded.length <= 7500);
    const page = JSON.parse(encoded);
    reconstructed += page.content;
    offset = page.nextOffset;
  }
  assert.equal(reconstructed, rawOutput);
  const forkPort = createSessionForkRuntimePort();
  const forkSeed = (await recovered.readDurableForkSnapshot()).runtimeSeedEntries;
  const unknownRef = "pico://archive/other-session/unknown/" + "0".repeat(64) + "/5";
  const fork = {
    sourceSessionId: recovered.id,
    targetSessionId: "archive-fork-target",
    operationId: "archive-fork",
    seedEntries: forkSeed,
    modelCheckpoint: {
      coveredMessageCount: forkSeed.filter((entry) => entry.kind === "model").length,
      summary: {
        role: "assistant" as const,
        content: `Summary known ${ref}; unknown ${unknownRef}`,
      },
    },
    workDir: fixture.workDir,
    runtimeAuthority: recovered.runtimeEventStore!,
    publication: { async assertOwned() {} },
  };
  await forkPort.bootstrapFork(fork);
  await forkPort.bootstrapFork(fork); // Durable idempotency compares the rebound projection.
  const forkResult = (await recovered.runtimeEventStore!.readSession(fork.targetSessionId)).find(
    (event) =>
      event.kind === "tool.result.recorded" && event.refs.toolCallId === LARGE_TOOL_CALL_ID,
  ) as RuntimeToolResultRecordedEvent;
  const forkRef = forkResult.data.projection.text.match(/pico:\/\/archive\/[^"\s]+/u)![0];
  assert.notEqual(forkRef, ref);
  const forkCheckpoint = (
    await recovered.runtimeEventStore!.readSession(fork.targetSessionId)
  ).find((event) => event.kind === "context.checkpoint.recorded");
  assert.ok(forkCheckpoint?.kind === "context.checkpoint.recorded");
  assert.ok(forkCheckpoint.data.summary.content.includes(forkRef));
  assert.ok(!forkCheckpoint.data.summary.content.includes(ref));
  assert.ok(forkCheckpoint.data.summary.content.includes(unknownRef));
  assert.equal(
    JSON.parse(
      await bindToolResultArchiveReader(recovered.runtimeEventStore!, fork.targetSessionId).read(
        forkRef,
        rawOutput.indexOf(canary) + 1,
        canary.length,
      ),
    ).content,
    canary,
  );
  await assert.rejects(reader.read(forkRef, 1, 1000), /不属于当前会话/u);
  await assert.rejects(
    bindToolResultArchiveReader(recovered.runtimeEventStore!, "another-session").read(ref, 1, 1000),
    /不属于当前会话/u,
  );
  await assert.rejects(
    reader.read(ref.replace(largeResult.data.body.sha256, "0".repeat(64)), 1, 1000),
    /完整性校验失败/u,
  );
  await assert.rejects(reader.read(ref + "?path=other", 1, 1000), /URI 无效/u);

  // A pre-upgrade inline event is projected after two newer turns, without mutation.
  const legacy = {
    ...largeResult,
    data: {
      ...largeResult.data,
      projection: {
        version: 1 as const,
        mode: "full" as const,
        strategy: "original",
        truncated: false,
        text: rawOutput,
      },
    },
  };
  const entry = {
    eventId: legacy.eventId,
    message: { role: "user" as const, content: rawOutput, toolCallId: LARGE_TOOL_CALL_ID },
  };
  assert.equal(archiveStaleToolResultEntries([legacy], [entry])[0]!.message.content, rawOutput);
  const newer = [1, 2].map((number) => ({
    ...legacy,
    eventId: `newer-${number}`,
    turnId: `newer-turn-${number}`,
  }));
  const projected = archiveStaleToolResultEntries([legacy, ...newer], [entry]);
  assert.match(projected[0]!.message.content, /pico:\/\/archive/u);
  assert.equal(legacy.data.projection.text, rawOutput);
  const legacyRef = projected[0]!.message.content.match(/pico:\/\/archive\/[^"\s]+/u)![0];
  assert.equal(
    JSON.parse(await reader.read(legacyRef, rawOutput.indexOf(canary) + 1, canary.length)).content,
    canary,
  );
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
