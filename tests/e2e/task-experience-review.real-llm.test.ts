import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import type { Message } from "@pico/core";
import {
  createRuntimeRequest,
  parseRuntimeResult,
  type RuntimeArtifactInputAttachment,
  type RuntimeResult,
} from "@pico/protocol";
import { AgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProductionRuntimeServices } from "@pico/pico-host/production-host";
import {
  UserConfigStore,
  EMPTY_USER_CONFIG_REVISION,
} from "@pico/pico-host/input/user-config-store";
import { getExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

const enabledTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

/** Only the initial mistaken call is controlled; correction, reflection and reuse use the configured real model. */
class LearningFixtureRuntime extends AgentRuntime {
  private first = true;
  override async execute(
    options: Parameters<AgentRuntime["execute"]>[0],
    host: Parameters<AgentRuntime["execute"]>[1] = {},
  ) {
    const controlled = this.first;
    this.first = false;
    let called = false;
    const initialProvider = {
      generate: async (messages: readonly Message[]): Promise<Message> => {
        if (called) return { role: "assistant", content: '{"sum":20}' };
        called = true;
        const ref = messages
          .map((message) => message.content)
          .join("\n")
          .match(/pico:\/\/artifact\/([^\s"<>\])]+)/u)?.[1];
        assert.ok(ref, "initial upload must be bound to the current Session");
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "controlled-header-default",
              name: "document",
              arguments: JSON.stringify({
                artifact_id: decodeURIComponent(ref),
                action: "analyze",
                sheet: "Sheet1",
                range: "B2:B3",
                column: "B",
                operation: "sum",
              }),
            },
          ],
        };
      },
    };
    return super.execute(options, {
      ...host,
      maxTurns: 8,
      executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
      ...(controlled ? { provider: initialProvider } : {}),
    });
  }
}

enabledTest(
  "reviewed Excel method is learned in the background and used on a new attachment by the real model",
  { timeout: 360_000 },
  async (t) => {
    const model = await loadUserDefaultRealModel();
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-task-experience-real-")));
    const picoHome = join(root, "home"),
      workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await mkdir(picoHome);
    const secretEnv = "PICO_TASK_EXPERIENCE_TEST_KEY";
    const userConfigStore = new UserConfigStore({ picoHome });
    await userConfigStore.write(
      {
        version: 1,
        defaults: {
          modelRouteId: model.route.id,
          collaborationMode: "agent",
          permissionMode: "full-access",
          orchestrationMode: "default",
        },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv: secretEnv,
            ...(model.route.auth ? { auth: model.route.auth } : {}),
            discoverModels: false,
            models: [model.route.model],
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    const services = createProductionRuntimeServices({
      env: { ...process.env, PICO_HOME: picoHome, [secretEnv]: model.config.apiKey },
      userConfigStore,
      agentRuntime: new LearningFixtureRuntime(),
    });
    const sessions: string[] = [];
    t.after(async () => {
      await services.desktopService.close();
      for (const sessionId of sessions)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      if (process.env.PICO_KEEP_EXPERIENCE_E2E !== "1")
        await rm(root, { recursive: true, force: true });
      else t.diagnostic(`fixture retained: ${root}`);
    });
    await services.trustStore.trust(workspacePath);
    const createSession = async () => {
      const result = parseRuntimeResult(
        "session.create",
        await services.desktopService.handle(
          createRuntimeRequest("session.create", { workspacePath }),
        ),
      );
      sessions.push(result.session.sessionId);
      return result.session.sessionId;
    };
    const upload = async (
      sessionId: string,
      name: string,
      numbers: readonly number[],
    ): Promise<RuntimeArtifactInputAttachment> => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      numbers.forEach((value, index) => {
        sheet.getCell(index + 2, 2).value = value;
      });
      const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      const listed = (await services.desktopService.handle(
        createRuntimeRequest("session.artifacts.query", {
          workspacePath,
          sessionId,
          action: "list",
        }),
      )) as Record<string, unknown>;
      const begun = (await services.desktopService.handle(
        createRuntimeRequest("session.artifacts.command", {
          workspacePath,
          sessionId,
          action: "begin",
          title: name,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          expectedRevision: Number(listed.revision),
          idempotencyKey: randomUUID(),
        }),
      )) as Record<string, unknown>;
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
        await services.desktopService.handle(
          createRuntimeRequest("session.artifacts.command", {
            workspacePath,
            sessionId,
            action: "append",
            ingestId: String(begun.ingestId),
            offsetBytes: offset,
            contentBase64: bytes.subarray(offset, offset + 32 * 1024).toString("base64"),
          }),
        );
      const digest = createHash("sha256").update(bytes).digest("hex");
      await services.desktopService.handle(
        createRuntimeRequest("session.artifacts.command", {
          workspacePath,
          sessionId,
          action: "commit",
          ingestId: String(begun.ingestId),
          expectedRevision: Number(begun.revision),
          expectedDigest: digest,
          expectedSizeBytes: bytes.length,
          idempotencyKey: randomUUID(),
        }),
      );
      return { type: "artifact", artifactId: String(begun.artifactId), digest };
    };
    let taskNumber = 0;
    const send = async (
      sessionId: string,
      text: string,
      attachments?: readonly RuntimeArtifactInputAttachment[],
    ) => {
      const stage = ++taskNumber;
      const sent = (await services.desktopService.handle(
        createRuntimeRequest("session.send", {
          workspacePath,
          sessionId,
          input: { kind: "text", text, ...(attachments ? { attachments } : {}) },
          idempotencyKey: randomUUID(),
        }),
      )) as RuntimeResult<"session.send">;
      assert.ok(sent.run);
      const runtime = await services.service.getWorkspaceRuntime(workspacePath);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        runtime.waitForRun(sent.run.runId),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            const status = runtime.getRun(sent.run!.runId)?.status ?? "unknown";
            runtime.cancel(sent.run!.runId, "Learning E2E run deadline");
            reject(
              new Error(
                `Real-model learning task ${stage} did not settle autonomously within 90s (status: ${status})`,
              ),
            );
          }, 90_000);
        }),
      ]).finally(() => {
        if (deadline) clearTimeout(deadline);
      });
      assert.equal(settled.status, "succeeded", settled.error);
      return sent.run.runId;
    };
    const sourceSession = await createSession();
    const old = await upload(sourceSession, "预算.xlsx", [10, 20]);
    await send(
      sourceSession,
      '请用 document 计算 Excel 附件 Sheet1 的 B2:B3 合计，返回 JSON {"sum":数值}，并说明来源。',
      [old],
    );
    await send(
      sourceSession,
      '刚才的结果有误。B2 也是数据，不是表头，请重新用 document 计算 Sheet1 的 B2:B3 合计，只返回 JSON {"sum":数值} 与来源。',
    );
    const worker = getExecutionLearningWorker(picoHome);
    assert.ok(worker);
    let pending: RuntimeResult<"memory.learning.query">["items"][number] | undefined;
    const deadline = Date.now() + 100_000;
    while (Date.now() < deadline) {
      await worker.flushOnce();
      await worker.drain();
      const list = parseRuntimeResult(
        "memory.learning.query",
        await services.desktopService.handle(
          createRuntimeRequest("memory.learning.query", {
            workspacePath,
            sessionId: sourceSession,
          }),
        ),
      );
      pending = list.items.find((item) => item.review === "pending" && item.content.length > 0);
      if (pending) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(pending, "canonical correction did not produce a background review suggestion");
    assert.equal(pending.validation, "unknown");
    assert.equal(pending.enabled, false);
    assert.equal(pending.itemId, undefined);
    assert.ok(
      !pending.content.includes(old.artifactId),
      "method must not embed the previous artifact ID",
    );
    const approved = parseRuntimeResult(
      "memory.learning.review",
      await services.desktopService.handle(
        createRuntimeRequest("memory.learning.review", {
          workspacePath,
          candidateId: pending.candidateId,
          expectedRecordRevision: pending.recordRevision,
          expectedContentVersion: pending.contentVersion,
          operationId: randomUUID(),
          action: "accept",
        }),
      ),
    );
    assert.equal(approved.candidate.review, "approved");
    assert.equal(approved.candidate.validation, "unknown");
    assert.equal(approved.candidate.enabled, true);
    const legacy = parseRuntimeResult(
      "memory.list",
      await services.desktopService.handle(
        createRuntimeRequest("memory.list", { workspacePath, paged: true }),
      ),
    );
    assert.equal(
      legacy.items.some((item) => item.itemId === approved.candidate.itemId),
      false,
      "old clients must not receive the new provenance enum",
    );
    const modern = parseRuntimeResult(
      "memory.list",
      await services.desktopService.handle(
        createRuntimeRequest("memory.list", { workspacePath, paged: true, learningVersion: 2 }),
      ),
    );
    assert.equal(
      modern.items.find((item) => item.itemId === approved.candidate.itemId)?.sourceType,
      "reviewed-reference",
    );
    const beforeReuseSettings = parseRuntimeResult("memory.settings.get", await services.desktopService.handle(createRuntimeRequest("memory.settings.get", {workspacePath})));
    await services.desktopService.handle(createRuntimeRequest("memory.settings.update", {workspacePath, expectedVersion: beforeReuseSettings.settings.version, idempotencyKey: randomUUID(), autoExtract: false}));
    const reusedSession = await createSession();
    const current = await upload(reusedSession, "新预算.xlsx", [7, 11]);
    assert.notEqual(current.artifactId, old.artifactId);
    await send(
      reusedSession,
      '请用 document 计算这份新 Excel 附件 Sheet1 的 B2:B3 合计，只返回 JSON {"sum":数值} 与来源。',
      [current],
    );
    await worker.flushOnce();
    await worker.drain();
    const query = parseRuntimeResult(
      "memory.learning.query",
      await services.desktopService.handle(
        createRuntimeRequest("memory.learning.query", { workspacePath, sessionId: reusedSession }),
      ),
    );
    const reuse = query.reuse.find((receipt) => receipt.candidateId === pending!.candidateId && receipt.adoption === "observed" && receipt.validation === "pass");
    assert.ok(reuse, "the new task did not receive the reviewed method");
    assert.equal(reuse.contentVersion, approved.candidate.contentVersion);
    assert.ok(reuse.referenceContent);
    assert.equal(reuse.adoption, "observed");
    assert.equal(reuse.validation, "pass");
    const ledger = parseRuntimeResult("memory.experience.query", await services.desktopService.handle(createRuntimeRequest("memory.experience.query", {workspacePath, sessionId: reusedSession})));
    const actualUse = ledger.uses.find(use => use.useId === reuse.reuseId && use.source.kind === "reviewed-reference");
    assert.ok(actualUse, "new shared ledger must contain the actual reviewed method use while learning is off");
    assert.equal(actualUse.delivery, "carried");
    assert.equal(actualUse.historical, false);
    assert.equal(actualUse.validation, "pass");
    assert.equal(actualUse.validationScope, "spreadsheet-range");
    const actualDetail = parseRuntimeResult("memory.experience.detail", await services.desktopService.handle(createRuntimeRequest("memory.experience.detail", {workspacePath, useId:actualUse.useId})));
    assert.ok(actualDetail.effects.some(effect => effect.validation === "pass" && effect.preparedSequence > actualUse.deliverySequence!));
    const paths = resolvePicoPaths(workspacePath, { picoHome });
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    try {
      const sourceEvents = await events.readSession(sourceSession);
      const sourceToolResults = sourceEvents.filter(
        (event) => event.kind === "tool.result.recorded" && event.data.toolName === "document",
      );
      const sums = sourceToolResults.map((event) => {
        if (event.kind !== "tool.result.recorded") return null;
        try {
          const result = JSON.parse(
            event.data.body.storage === "inline" ? event.data.body.content : "",
          );
          return JSON.parse(result.text).result;
        } catch {
          return null;
        }
      });
      assert.ok(
        sums.includes(20) && sums.includes(30),
        "real source operations must demonstrate the actual error and correction",
      );
      const reusedEvents = await events.readSession(reusedSession);
      const analyzed = reusedEvents
        .filter((event) => event.kind === "tool.started" && event.data.toolName === "document")
        .map((event) => (event.kind === "tool.started" ? JSON.parse(event.data.argumentsJson) : {}))
        .filter((args) => args.action === "analyze");
      assert.ok(analyzed.length > 0);
      assert.equal(analyzed[0].header, false);
      assert.equal(
        analyzed[0].artifact_id.replace(/^pico:\/\/artifact\//u, ""),
        current.artifactId,
      );
      const answers = reusedEvents
        .filter(
          (event) => event.kind === "message.committed" && event.data.message.role === "assistant",
        )
        .map((event) => (event.kind === "message.committed" ? event.data.message.content : ""));
      assert.ok(
        answers.some((answer) => /"sum"\s*:\s*18/u.test(answer)),
        "real final answer must be 18",
      );
    } finally {
      events.close();
    }
  },
);
