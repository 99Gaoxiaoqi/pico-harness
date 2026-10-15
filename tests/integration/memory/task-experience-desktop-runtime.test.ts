import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
import { configureExecutionLearningHost } from "../../../packages/pico-host/dist/execution-learning-host.js";
import { getExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { resolvePicoPaths } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";

class DesktopLearningRuntime extends AgentRuntime {
  private invocation = 0;
  override async execute(
    options: Parameters<AgentRuntime["execute"]>[0],
    host: Parameters<AgentRuntime["execute"]>[1] = {},
  ) {
    const invocation = this.invocation++;
    let called = false;
    return super.execute(options, {
      ...host,
      maxTurns: 3,
      executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
      atomicMemoryModelFactory: async () => ({ model: { call: async () => '{"operations":[]}' } }),
      provider: {
        generate: async (messages: readonly Message[]): Promise<Message> => {
          if (called) return { role: "assistant", content: "已完成当前文件的范围计算。" };
          called = true;
          const reference = messages
            .map((message) => message.content)
            .join("\n")
            .match(/pico:\/\/artifact\/([^\s"<>\])]+)/u)?.[1];
          assert.ok(reference);
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: `document-${invocation}`,
                name: "document",
                arguments: JSON.stringify({
                  artifact_id: decodeURIComponent(reference),
                  action: "analyze",
                  sheet: "Sheet1",
                  range: "B2:B3",
                  column: "B",
                  operation: "sum",
                  ...(invocation ? { header: false } : {}),
                }),
              },
            ],
          };
        },
      },
    });
  }
}

test(
  "Desktop RPC独立身份绑定与低风险自动试用，附件warnings不纠正且未交付不晋级",
  { timeout: 30_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-desktop-task-binding-")));
    const picoHome = join(root, "home"),
      workspacePath = join(root, "workspace");
    await mkdir(picoHome);
    await mkdir(workspacePath);
    const config = new UserConfigStore({ picoHome });
    await config.write(
      {
        version: 1,
        defaults: {
          modelRouteId: "fixture/control",
          collaborationMode: "agent",
          permissionMode: "full-access",
          orchestrationMode: "default",
        },
        providers: {
          fixture: {
            protocol: "openai",
            baseURL: "http://127.0.0.1:1",
            apiKeyEnv: "PICO_UNUSED_CONTROLLED_PROVIDER_KEY",
            auth: "none",
            discoverModels: false,
            models: ["control"],
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    const services = createProductionRuntimeServices({
      env: { ...process.env, PICO_HOME: picoHome },
      userConfigStore: config,
      agentRuntime: new DesktopLearningRuntime(),
    });
    const memory = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const paths = resolvePicoPaths(workspacePath, { picoHome });
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    const sessions: string[] = [];
    t.after(async () => {
      await services.desktopService.close();
      for (const sessionId of sessions)
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
      events.close();
      memory.close();
      await rm(root, { recursive: true, force: true });
    });
    await services.trustStore.trust(workspacePath);
    // The production worker still validates canonical sources and derives the Host spreadsheet
    // predicate. Only its model response is controlled in this deterministic integration.
    configureExecutionLearningHost(picoHome, {
      modelFactory: async () => ({
        model: {
          call: async (request) => {
            const candidate = (
              await memory.taskExperiences.queryTaskExperiences(paths.workspace.id)
            ).find((candidate) => candidate.taskVersion === 2 && candidate.review === "unneeded");
            assert.ok(candidate);
            const evidence = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf("\n") + 1))
              .evidence as readonly { evidenceId: string }[];
            return JSON.stringify({
              content:
                "对当前表格明确工作表和范围。纯数值范围求和时包含首行，设置header=false，并报告来源范围。",
              applicability: {
                taskFamily: "spreadsheet",
                toolNames: ["document"],
                conditions: ["范围内为纯数值"],
              },
              evidenceIds: evidence.map(({ evidenceId }) => evidenceId),
            });
          },
        },
      }),
    });
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
      title: string,
      values: readonly number[],
    ): Promise<RuntimeArtifactInputAttachment> => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      values.forEach((value, index) => {
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
          title,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          expectedRevision: Number(listed.revision),
          idempotencyKey: randomUUID(),
        }),
      )) as Record<string, unknown>;
      await services.desktopService.handle(
        createRuntimeRequest("session.artifacts.command", {
          workspacePath,
          sessionId,
          action: "append",
          ingestId: String(begun.ingestId),
          offsetBytes: 0,
          contentBase64: bytes.toString("base64"),
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
    const send = async (
      sessionId: string,
      text: string,
      attachments?: readonly RuntimeArtifactInputAttachment[],
    ) => {
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
      const settled = await runtime.waitForRun(sent.run.runId);
      assert.equal(settled.status, "succeeded", settled.error);
      return sent.run.runId;
    };
    const sourceSession = await createSession(),
      originalFile = await upload(sourceSession, "这条经验不对.xlsx", [10, 20]);
    const firstHostRun = await send(sourceSession, "请用document计算Excel附件Sheet1的B2:B3合计。", [
      originalFile,
    ]);
    const firstTask = await memory.taskExperiences.latestTaskExperienceTask(
      paths.workspace.id,
      sourceSession,
    );
    assert.ok(firstTask);
    assert.equal(firstTask.runId, firstHostRun);
    assert.notEqual(firstTask.executionRunId, firstHostRun);
    assert.notEqual(firstTask.goalSource.runId, firstTask.executionRunId);
    assert.equal(firstTask.goal, "请用document计算Excel附件Sheet1的B2:B3合计。");
    assert.equal(
      (await memory.taskExperiences.queryTaskExperiences(paths.workspace.id)).length,
      0,
      "Host附件错误值warnings不能创建纠正候选",
    );
    const diagnostics = new DatabaseSync(join(picoHome, "memory.sqlite"), { readOnly: true });
    try {
      assert.equal(
        Number(
          diagnostics
            .prepare("SELECT management_revision FROM execution_learning_control WHERE scope='*'")
            .get()?.management_revision ?? 0,
        ),
        0,
        "附件标题不能触发native用户管理意图",
      );
    } finally {
      diagnostics.close();
    }
    const correctionHostRun = await send(
      sourceSession,
      "B2也是数据，不是表头，请重算Sheet1的B2:B3合计。",
    );
    const correctedTask = await memory.taskExperiences.latestTaskExperienceTask(
      paths.workspace.id,
      sourceSession,
    );
    assert.equal(correctedTask?.taskId, firstTask.taskId);
    assert.equal(correctedTask?.taskVersion, 2);
    assert.equal(correctedTask?.runId, correctionHostRun);
    assert.equal(correctedTask?.goalSource.eventId, firstTask.goalSource.eventId);
    const observations = await memory.taskExperiences.listTaskExperienceObservations(
      firstTask.taskId,
    );
    const methodResults = observations.filter(
      (observation) => observation.kind === "tool-result" && observation.toolName === "document",
    );
    assert.equal(methodResults.length, 2);
    const sums: unknown[] = [];
    for (const observation of methodResults) {
      const entry = await events.readSessionEvent(sourceSession, observation.source.eventId);
      assert.equal(entry?.event.kind, "tool.result.recorded");
      if (
        entry?.event.kind === "tool.result.recorded" &&
        entry.event.data.body.storage === "inline"
      )
        sums.push(JSON.parse(JSON.parse(entry.event.data.body.content).text).result);
    }
    assert.deepEqual(sums, [20, 30]);
    const worker = getExecutionLearningWorker(picoHome);
    assert.ok(worker);
    let trial;
    const reflectionDeadline = Date.now() + 12_000;
    while (Date.now() < reflectionDeadline) {
      await worker.flushOnce();
      await worker.drain();
      trial = (await memory.taskExperiences.queryTaskExperiences(paths.workspace.id)).find(
        (candidate) => candidate.state === "saved" && candidate.maturity === "trial",
      );
      if (trial) break;
      await delay(250);
    }
    assert.ok(
      trial,
      JSON.stringify(await memory.taskExperiences.queryTaskExperiences(paths.workspace.id)),
    );
    assert.equal(trial.runId, correctionHostRun);
    assert.equal(
      trial.review,
      "unneeded",
      "low-risk candidates enter restricted trial without review RPC",
    );
    assert.equal(trial.risk, "low");
    assert.equal(trial.enabled, true);
    assert.equal(trial.validation, "unknown");
    assert.equal(trial.positiveReuseCount, 0);
    assert.equal(trial.promotionReason, "none");
    assert.ok(trial.itemId);
    assert.deepEqual(trial.applicability.spreadsheet, {
      operation: "sum",
      header: false,
      dataKind: "finite-numbers",
    });
    const currentSession = await createSession(),
      currentFile = await upload(currentSession, "新预算.xlsx", [7, 11]);
    const reuseHostRun = await send(
      currentSession,
      "请用document计算这份新Excel附件Sheet1的B2:B3合计。",
      [currentFile],
    );
    const query = parseRuntimeResult(
      "memory.learning.query",
      await services.desktopService.handle(
        createRuntimeRequest("memory.learning.query", { workspacePath, sessionId: currentSession }),
      ),
    );
    // The v2 projection cannot represent an unconfirmed physical delivery.
    assert.equal(query.reuse.length, 0);
    const uses = parseRuntimeResult(
      "memory.experience.query",
      await services.desktopService.handle(
        createRuntimeRequest("memory.experience.query", {
          workspacePath,
          sessionId: currentSession,
        }),
      ),
    );
    const receipt = uses.uses.find(
      (receipt) =>
        receipt.source.kind === "reviewed-reference" &&
        receipt.source.candidateId === trial.candidateId,
    );
    assert.ok(receipt);
    assert.equal(receipt.hostRunId, reuseHostRun);
    // This deterministic provider does not expose a physical request lifecycle.
    assert.equal(receipt.delivery, "pending");
    assert.equal(receipt.adoption, "unknown");
    assert.equal(receipt.validation, "unknown");
    assert.ok(receipt.referenceContent);
    const afterReuse = await memory.taskExperiences.readTaskExperienceCandidate(trial.candidateId);
    assert.equal(afterReuse?.review, "unneeded");
    assert.equal(
      afterReuse?.maturity,
      "trial",
      "without confirmed physical delivery a successful tool result cannot promote the trial",
    );
    assert.equal(afterReuse?.enabled, true);
    assert.equal(afterReuse?.validation, "unknown");
    assert.equal(afterReuse?.positiveReuseCount, 0);
    assert.equal(afterReuse?.promotionReason, "none");
    assert.equal(
      (
        await memory.taskExperiences.queryTaskExperiences(paths.workspace.id, {
          sessionId: currentSession,
        })
      ).length,
      0,
      "新附件正常请求不因warnings创建候选",
    );
  },
);
