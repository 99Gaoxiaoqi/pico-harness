import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import ExcelJS from "exceljs";
import type { LLMProvider, LLMProviderRequestOptions, TaskExperienceTask } from "@pico/core";
import { Session } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { RuntimeRun } from "@pico/runtime/runtime-run";
import { CostTracker } from "@pico/runtime/cost-tracker";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { ExperienceFeedbackRuntime } from "../../../packages/pico-host/src/experience-feedback-runtime.js";
import { canonicalTaskArguments } from "../../../packages/pico-host/src/task-experience-runtime.js";
import { validateSpreadsheetTaskExperience } from "../../../packages/pico-host/src/task-experience-validation.js";

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const args = {
  artifact_id: "current-input",
  action: "analyze",
  operation: "sum",
  header: false,
  sheet: "Sheet1",
  range: "B2:B3",
  column: "B",
};
const tool = {
  id: "current-sum",
  type: "function",
  function: { name: "document", arguments: JSON.stringify(args) },
};
const tools = [
  {
    name: "document",
    description: "Analyze the current attachment.",
    inputSchema: { type: "object", additionalProperties: true },
  },
];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function respond(res: ServerResponse, streaming: boolean): void {
  if (streaming) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame({
        id: "fixture",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", tool_calls: [{ index: 0, ...tool }] },
            finish_reason: null,
          },
        ],
      }) +
        frame({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
        "data: [DONE]\n\n",
    );
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [tool] },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );
  }
}

async function fixture(t: TestContext, reply = respond) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-experience-transport-")));
  const paths = resolvePicoPaths(root, { picoHome: join(root, "home") });
  const session = new Session("transport", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  });
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  const ledger = new SqliteRuntimeControlStore({ storageRoot: paths.workspace.root });
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as Record<string, unknown>;
    bodies.push(body);
    reply(res, body.stream === true);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await session.close();
    ledger.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const run = await RuntimeRun.start({
    capability: session.runtimeEventCapability!,
    agentSwarmAuthorization: "none",
  });
  const workspaceKey = paths.workspace.id,
    now = Date.now();
  const goal = "求当前 Excel Sheet1!B2:B3 的 B列总和。[附件](pico://artifact/current-input)";
  await run.recordTranscriptMessage({ role: "user", content: goal });
  const input = (await session.runtimeEventStore!.readRun(session.id, run.runId)).find(
    (event) => event.kind === "message.committed",
  )!;
  const source = {
    sessionId: session.id,
    runId: run.runId,
    turnId: input.turnId,
    eventId: input.eventId,
  };
  const task: TaskExperienceTask = {
    taskId: "task",
    taskVersion: 1,
    workspaceKey,
    workDir: root,
    sessionId: session.id,
    runId: run.runId,
    goal,
    goalSource: source,
    coverage: "complete",
    throughSequence: 1,
    createdAt: now,
    updatedAt: now,
  };
  // An isolated reviewed-method seed; recall, transport, tool journal and effects are real.
  await store.taskExperiences.appendTaskExperienceObservations(task, [
    {
      observationId: "observation",
      taskId: task.taskId,
      taskVersion: 1,
      kind: "user-input",
      source,
      sequence: 1,
      summary: goal,
      coverage: "complete",
      createdAt: now,
    },
  ]);
  const epoch = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
  await store.taskExperiences.createTaskExperienceCandidate({
    candidateId: "candidate",
    kind: "task-lesson",
    taskId: task.taskId,
    taskVersion: 1,
    workspaceKey,
    workDir: root,
    sessionId: session.id,
    runId: run.runId,
    failureKey: "seed",
    inputEpoch: epoch.inputEpoch,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "waiting",
    lifecycleState: "active",
    goal,
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: [source],
    observationIds: ["observation"],
    createdAt: now,
    updatedAt: now,
  });
  const job = await store.executionLearning.claimExecutionLearningJob("worker", now + 1, 60_000);
  assert.ok(job);
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: 1,
    content: "对当前数值范围求和，明确 header=false。",
    applicability: {
      taskFamily: "spreadsheet",
      toolNames: ["document"],
      conditions: [],
      spreadsheet: { operation: "sum", header: false, dataKind: "finite-numbers" },
    },
    sources: [source],
    now: now + 2,
  });
  assert.ok(pending);
  const candidate = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: pending.candidateId,
    expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: 1,
    action: "accept",
    operationId: "accept",
    now: now + 3,
  });
  const memory = await new AtomicMemoryContextBuilder(store, workspaceKey).build("Excel 求和", {
    reviewedExperiences: [
      {
        candidateId: candidate.candidateId,
        contentVersion: candidate.contentVersion,
        recordRevision: candidate.recordRevision,
      },
    ],
    trace: {},
  });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.getCell("B2").value = 7;
  sheet.getCell("B3").value = 11;
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer()),
    digest = sha(bytes);
  const feedback = new ExperienceFeedbackRuntime({
    session,
    workspaceKey,
    workDir: root,
    picoHome: join(root, "home"),
    store,
    currentTask: () => task,
    referenceGate: async () => ({ allowed: true }),
    effectGate: async () => ({ allowed: true }),
    nativeGate: async () => ({ allowed: true }),
    io: { realpath: async () => undefined, readFile: async () => undefined },
    validateReviewed: async ({ candidate: current, observation, event, start }) =>
      validateSpreadsheetTaskExperience({
        candidate: current,
        task,
        observation,
        canonicalArguments: canonicalTaskArguments(start),
        canonicalResult:
          event.kind === "tool.result.recorded" && event.data.body.storage === "inline"
            ? event.data.body.content
            : "",
        artifactBytes: bytes,
        artifactDigest: digest,
        currentArtifactId: "current-input",
        now: Date.now(),
      }),
  });
  feedback.admit(run.runId);
  const recallEventId = await run.recordRecall(memory.trace!);
  await feedback.recordReferences(memory, recallEventId);
  const uses = () =>
    store.experienceLedger.queryExperienceUses(workspaceKey).then((page) => page.uses);
  assert.equal((await uses()).length, 1);
  const port = (server.address() as { port: number }).port;
  const raw = new AiSdkProvider("openai", {
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: "fixture",
    model: "transport",
    capabilities: resolveModelRouteCapabilities("openai", "transport", {
      cache: true,
      promptCache: { mode: "implicit" },
    }),
  });
  const generate = async (
    streaming: boolean,
    options: LLMProviderRequestOptions = {},
    provider: LLMProvider = raw,
    confirmationDelay = 0,
  ) => {
    const tracked = new CostTracker(
      provider,
      { provider: "openai", model: "transport", billingMode: "subscription_included" },
      session,
      {
        ledger,
        context: { purpose: "main", sessionId: session.id },
        onPreparedRecallDispatched: async (input) => {
          await delay(confirmationDelay);
          await feedback.dispatched(input);
        },
        contextFacts: {
          version: 1,
          memoryRecall: {
            version: 1,
            coverage: "recorded",
            recalls: [
              {
                recallEventId,
                blockHash: memory.trace!.blockHash,
                references: memory.trace!.selected.map((item) => ({
                  itemId: item.itemId,
                  referenceHash: item.referenceHash,
                })),
              },
            ],
          },
        },
      },
    );
    const messages = [{ role: "user" as const, content: memory.block }];
    return streaming
      ? tracked.generateStream(messages, tools, () => {}, options)
      : tracked.generate(messages, tools, options);
  };
  const effect = async (result = 18) => {
    await run.recordToolStarted(tool.id, "document", JSON.stringify(args));
    const numeric = {
      sheet: "Sheet1",
      range: "B2:B3",
      dataRange: "B2:B3",
      column: "B",
      operation: "sum",
      header: false,
      groupBy: null,
      filters: [],
      totalRows: 2,
      matchedRows: 2,
      numericValues: 2,
      emptyValues: 0,
      nonNumericValues: 0,
      formulaCacheMissing: 0,
      formulaCacheUsed: 0,
      filterAndGroupFormulaCacheUsed: 0,
      completeNumericCoverage: true,
      result,
    };
    const content = JSON.stringify({
      kind: "spreadsheet",
      source: { action: "analyze", digest, ref: "pico://artifact/current-input" },
      text: JSON.stringify(numeric),
    });
    await run.recordTranscriptToolResults([
      {
        toolCallId: tool.id,
        toolName: "document",
        status: "succeeded",
        body: {
          storage: "inline",
          content,
          sha256: sha(content),
          sizeBytes: Buffer.byteLength(content),
        },
        projection: { version: 1, mode: "full", text: content, strategy: "full", truncated: false },
      },
    ]);
    await feedback.committed({ id: tool.id, name: "document", arguments: JSON.stringify(args) });
  };
  return { run, raw, store, ledger, feedback, bodies, uses, generate, effect, memory };
}

test("发送前取消不冒记携带；无HTTP响应的断网及HTTP错误保持未确认", async (t) => {
  const cancelled = await fixture(t);
  const controller = new AbortController();
  await cancelled.run.run(async () => {
    await assert.rejects(
      cancelled.generate(false, {
        signal: controller.signal,
        onProviderAttemptStart: async () => controller.abort(new Error("cancelled-before-fetch")),
      }),
    );
    assert.equal((await cancelled.uses())[0]!.delivery, "pending");
    const physical = cancelled.ledger.listPhysicalAttempts({ sessionId: "transport" })[0]!;
    const started = (await cancelled.run.store.readRun("transport", cancelled.run.runId)).find(
      (event) => event.kind === "model.call.started",
    )!;
    const entry = await cancelled.run.store.readSessionEvent("transport", started.eventId);
    assert.ok(entry);
    // Simulate the old writer's persisted false carry; it must not authorize a new contradiction.
    const use = (await cancelled.uses())[0]!;
    await cancelled.store.experienceLedger.deliverExperienceUse({
      useId: use.useId,
      providerCallId: physical.providerCallId,
      physicalAttemptId: physical.physicalAttemptId,
      deliverySequence: entry.sequence,
      now: Date.now(),
    });
    await cancelled.effect(99);
    assert.equal((await cancelled.uses())[0]!.adoption, "unknown");
    assert.equal(
      (await cancelled.store.experienceLedger.listExperienceEffects(use.useId)).length,
      0,
    );
    assert.equal(
      (await cancelled.store.taskExperiences.readTaskExperienceCandidate("candidate"))?.enabled,
      true,
    );
  });
  assert.equal(cancelled.bodies.length, 0);
  for (const mode of ["disconnect", "http-error"] as const) {
    const f = await fixture(t, (res) => {
      if (mode === "disconnect") res.destroy();
      else {
        res.writeHead(503);
        res.end('{"error":{"message":"unavailable"}}');
      }
    });
    await f.run.run(async () => {
      await assert.rejects(f.generate(false));
    });
    assert.equal(f.bodies.length, 1);
    const use = (await f.uses())[0]!;
    assert.equal(use.delivery, "pending");
    assert.equal(use.adoption, "unknown");
  }
});

test("非流式及流式2xx确认在工具准备前完成，延迟确认仍保留独立Excel效果", async (t) => {
  for (const streaming of [false, true]) {
    const f = await fixture(t);
    await f.run.run(async () => {
      const result = await f.generate(streaming, {}, f.raw, 25);
      assert.equal(result.toolCalls?.[0]?.name, "document");
      assert.equal((await f.uses())[0]!.delivery, "carried", "Provider正常返回前须等待确认");
      await f.effect();
    });
    assert.equal(f.bodies.length, 1);
    const use = (await f.uses())[0]!;
    assert.equal(use.adoption, "observed");
    assert.equal(use.validation, "pass");
    const effects = await f.store.experienceLedger.listExperienceEffects(use.useId);
    assert.equal(effects.length, 1);
    assert.ok(effects[0]!.preparedSequence > use.deliverySequence!);
  }
});

test("兼容降级使用每physicalAttempt自己的body：错误请求不能为成功请求借用片段", async (t) => {
  for (const presentOnSuccess of [false, true]) {
    let responses = 0;
    const f = await fixture(t, (res, streaming) => {
      if (responses++ === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":{"message":"unknown parameter prompt_cache_key"}}');
      } else respond(res, streaming);
    });
    let prepared = 0;
    const provider: LLMProvider = {
      requestCapabilities: f.raw.requestCapabilities,
      generate: (messages, availableTools, options) =>
        f.raw.generate(messages, availableTools, {
          ...options,
          onRequestPrepared: (request) => {
            const present = prepared++ === 0 ? !presentOnSuccess : presentOnSuccess;
            (request.body as Record<string, unknown>).messages = [
              { role: "user", content: present ? f.memory.block : "carrier omitted" },
            ];
            options?.onRequestPrepared?.(request);
          },
        }),
    };
    await f.run.run(() => f.generate(false, {}, provider));
    assert.equal(f.bodies.length, 2);
    assert.notDeepEqual(f.bodies[0]!.messages, f.bodies[1]!.messages);
    const use = (await f.uses())[0]!;
    assert.equal(use.delivery, presentOnSuccess ? "carried" : "pending");
    if (presentOnSuccess) {
      const accepted = f.ledger
        .listPhysicalAttempts({ providerCallId: use.providerCallId })
        .find((attempt) => attempt.httpStatus === 200)!;
      assert.equal(use.physicalAttemptId, accepted.physicalAttemptId);
    }
  }
});

test("取得2xx后取消保留真实携带但不冒认采用；携带写入失败不重发HTTP", async (t) => {
  const cancelled = await fixture(t);
  const controller = new AbortController();
  await cancelled.run.run(async () => {
    await assert.rejects(
      cancelled.generate(false, {
        signal: controller.signal,
        onProviderAttemptUpdate: async (snapshot) => {
          if (snapshot.status === "observed")
            controller.abort(new Error("cancelled-after-response"));
        },
      }),
    );
    for (
      let attempt = 0;
      attempt < 20 && (await cancelled.uses())[0]!.delivery !== "carried";
      attempt++
    )
      await delay(5);
  });
  assert.equal(cancelled.bodies.length, 1);
  const use = (await cancelled.uses())[0]!;
  assert.equal(use.delivery, "carried");
  assert.equal(use.adoption, "unknown");
  assert.equal((await cancelled.store.experienceLedger.listExperienceEffects(use.useId)).length, 0);
  const failedWrite = await fixture(t);
  failedWrite.store.experienceLedger.deliverExperienceUse = async () => {
    throw new Error("local write unavailable");
  };
  await failedWrite.run.run(() => failedWrite.generate(false));
  assert.equal(failedWrite.bodies.length, 1);
  assert.equal((await failedWrite.uses())[0]!.delivery, "pending");
});
