/** Isolated production Runtime runner, copied unchanged to the frozen v15 checkout for comparison. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  LLMProvider,
  Message,
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceTask,
} from "@pico/core";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { operationalDatabasePath, type PhysicalAttemptRecord } from "@pico/storage";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

export interface ReplayInput {
  readonly scenario: "fact" | "method" | "case" | "expired" | "correction" | "scope";
  readonly arm: "off" | "baseline" | "new";
  readonly variant: number;
  readonly root: string;
  readonly marker: string;
  readonly frozenAt: number;
  readonly reportPath: string;
}
const redact = (value: string): string =>
  value
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|access[_-]?token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu,
      "$1[redacted]",
    );

function providerLedger(input: ReplayInput) {
  const activeDir = join(input.root, input.scenario === "scope" ? "other" : "workspace");
  const storageRoot = resolvePicoPaths(activeDir, { picoHome: join(input.root, "home") }).workspace
    .root;
  try {
    const db = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT record_json FROM usage_physical_attempts WHERE session_id=? ORDER BY created_at, physical_attempt_id",
        )
        .all(`replay-${input.scenario}-${input.variant}-${input.arm}`);
      return {
        status: "reported",
        entries: rows.map((row) => {
          const record = JSON.parse(String(row.record_json)) as PhysicalAttemptRecord;
          return {
            physicalAttemptId: record.physicalAttemptId,
            logicalCallId: record.logicalCallId,
            providerCallId: record.providerCallId,
            provider: record.provider,
            model: record.model,
            route: record.route,
            purpose: record.purpose,
            status: record.status,
            retryAttempt: record.retryAttempt,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
            latencyMs: record.latencyMs,
            usageBasis: record.usageBasis,
            usage: record.usage ?? null,
            reportedCostCNY: record.costCNY ?? null,
            reportedCostStatus: record.costStatus,
            pricingVersion: record.pricingVersion,
            costCNY: null,
            costStatus: "unpriced",
          };
        }),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return { status: "unavailable", entries: [], reason: redact(String(error)).slice(0, 1000) };
  }
}

async function run(input: ReplayInput): Promise<void> {
  const model = await loadUserDefaultRealModel();
  await mkdir(input.root, { recursive: true });
  const root = await realpath(input.root);
  const workDir = join(root, "workspace"),
    otherDir = join(root, "other"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(otherDir);
  await mkdir(picoHome);
  const activeDir = input.scenario === "scope" ? otherDir : workDir;
  const key = resolvePicoPaths(workDir, { picoHome }).workspace.id;
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const now = input.frozenAt;
  const modern = store.schemaVersion() >= 16;
  const title = `回放专题${input.variant}`;
  const fact = async (content: string, operationId: string) => {
    const saved = await store.applyMutations({
      operationId,
      mutations: [
        {
          type: "create",
          item: {
            content,
            kind: "note",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: key,
            observedAt: now,
            origin: "user_requested",
            keys: [{ key: title, keyType: "concept", keyOrigin: "llm" }],
            sources: [],
          },
        },
      ],
    });
    return saved.results[0]!;
  };
  let candidate: TaskExperienceCandidate | undefined;
  if (["method", "case", "expired"].includes(input.scenario)) {
    const settings = await store.readSettings(key);
    const epoch = await store.executionLearning.advanceExecutionLearningInput(key);
    const source = {
      sessionId: "frozen-source",
      runId: "frozen-run",
      turnId: "frozen-turn",
      eventId: "frozen-correction",
    };
    const task: TaskExperienceTask = {
      taskId: "frozen-task",
      taskVersion: 1,
      workspaceKey: key,
      workDir,
      sessionId: source.sessionId,
      runId: source.runId,
      goal: `${title}范围报告的整理方法`,
      goalSource: source,
      coverage: "complete",
      throughSequence: 2,
      createdAt: now,
      updatedAt: now,
    };
    await store.taskExperiences.saveTaskExperienceTask(task);
    const observations: TaskExperienceObservation[] = [
      {
        observationId: "frozen-correction",
        taskId: task.taskId,
        taskVersion: 1,
        kind: "user-input",
        source,
        sequence: 1,
        summary: "用户明确要求范围报告先核对依据，再说明未知部分。",
        correction: true,
        coverage: "complete",
        createdAt: now,
      },
      {
        observationId: "frozen-result",
        taskId: task.taskId,
        taskVersion: 1,
        kind: "tool-result",
        source: { ...source, eventId: "frozen-result" },
        sequence: 2,
        summary: `报告产物包含方法标签 ${input.marker}，来源部分已经单独列出。`,
        status: "succeeded",
        toolName: "document.query",
        coverage: "complete",
        createdAt: now,
      },
    ];
    await store.taskExperiences.appendTaskExperienceObservations(task, observations);
    const initial: TaskExperienceCandidate = {
      candidateId: "frozen-method",
      kind: "task-lesson",
      lifecycleState: "active",
      taskId: task.taskId,
      taskVersion: 1,
      workspaceKey: key,
      workDir,
      sessionId: task.sessionId,
      runId: task.runId,
      failureKey: "frozen-method",
      inputEpoch: epoch.inputEpoch,
      settingsVersion: settings.version,
      deletionRevision: await store.readDeletionRevision(),
      state: "waiting",
      goal: task.goal,
      content: "",
      contentVersion: 1,
      recordRevision: 1,
      review: "unneeded",
      validation: "unknown",
      enabled: false,
      applicability: { taskFamily: "general", toolNames: [], conditions: [] },
      sources: observations.map((x) => x.source),
      observationIds: observations.map((x) => x.observationId),
      createdAt: now,
      updatedAt: now,
    };
    await store.taskExperiences.createTaskExperienceCandidate(initial);
    const job = await store.executionLearning.claimExecutionLearningJob(
      "replay-fixture",
      now + 1,
      90_000,
    );
    assert.ok(job, "frozen fixture did not obtain its reflection job");
    const completed = await store.taskExperiences.completeTaskExperienceJob({
      job,
      expectedRecordRevision: 1,
      content:
        input.scenario === "case"
          ? `历史案例：${title}范围报告的当时产物标签为 ${input.marker}。只记录过程，尚不能推出通用因果。`
          : `${title}范围报告可先核对依据，再列未知部分；给报告加上方法标签 ${input.marker} 以便追溯。`,
      applicability: { taskFamily: "general", toolNames: [], conditions: [`${title}范围报告`] },
      sources: initial.sources,
      representation: input.scenario === "case" ? "case" : "method",
      matchHints: [`${title}范围报告`],
      requiredConditions: [],
      now: now + 2,
    });
    assert.ok(completed);
    candidate = completed;
    if (input.scenario !== "case" || !modern) {
      candidate = await store.taskExperiences.reviewTaskExperience({
        workspaceKey: key,
        candidateId: completed.candidateId,
        expectedRecordRevision: completed.recordRevision,
        expectedContentVersion: 1,
        operationId: "frozen-user-approval",
        action: "accept",
        now: now + 3,
      });
    }
    if (input.scenario === "expired") {
      // A controlled historic fixture, never reported as a naturally learned or verified method.
      const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
      try {
        db.exec("BEGIN IMMEDIATE");
        db.prepare(
          "UPDATE execution_learning_candidates SET record_json=json_set(record_json,'$.expiresAt',?) WHERE candidate_id=?",
        ).run(now - 1, candidate.candidateId);
        db.prepare(
          "UPDATE execution_learning_items SET metadata_json=json_set(metadata_json,'$.expiresAt',?) WHERE candidate_id=?",
        ).run(now - 1, candidate.candidateId);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    }
  } else if (input.scenario === "correction") {
    const old = await fact(`${title}当前项目代号是 OLD_${input.marker}。`, "old-fact");
    await store.applyMutations({
      operationId: "archive-corrected-fact",
      mutations: [{ type: "archive", itemId: old.itemId, expectedVersion: old.version }],
    });
    await fact(`${title}用户明确纠正：当前项目代号是 ${input.marker}。`, "corrected-fact");
  } else {
    await fact(`${title}当前项目代号是 ${input.marker}。`, "frozen-fact");
  }
  const activeKey = resolvePicoPaths(activeDir, { picoHome }).workspace.id;
  const frozenContents = candidate
    ? [candidate.content]
    : (await store.listItems({ workspaceKey: key, includeArchived: true }))
        .map((record) => record.item.content)
        .sort();
  const sourceFreezeDigest = createHash("sha256")
    .update(
      JSON.stringify({ marker: input.marker, frozenAt: input.frozenAt, contents: frozenContents }),
    )
    .digest("hex");
  const settings = await store.readSettings(activeKey);
  await store.updateSettings({
    workspaceKey: activeKey,
    expectedVersion: settings.version,
    autoExtract: false,
    recallEnabled: input.arm !== "off",
  });
  store.close();
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trust.trust(await trust.canonicalize(activeDir));
  const main = createProvider(model.provider, model.config);
  const requests: Message[][] = [];
  const provider = new Proxy(main, {
    get(target, key) {
      if (key === "generate")
        return async (...args: Parameters<LLMProvider["generate"]>) => {
          requests.push(structuredClone(args[0]));
          return target.generate(...args);
        };
      if (key === "generateStream" && target.generateStream)
        return (...args: Parameters<NonNullable<LLMProvider["generateStream"]>>) => {
          requests.push(structuredClone(args[0]));
          return target.generateStream!(...args);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const prompt =
    input.scenario === "case"
      ? `请主动查找${title}范围报告的历史案例，只说当时产物标签，不推导通用规则。使用可用的记忆搜索工具；若支持案例模式请使用案例模式。找不到就输出 UNKNOWN。`
      : ["method", "expired"].includes(input.scenario)
        ? `请给${title}范围报告写两句整理建议，可参考适用的工作区历史方法，并保留其方法标签（如果确实知道）。没有历史方法则输出普通建议，不要猜标签。`
        : `${title}当前项目代号是什么？只依据当前工作区记忆，输出完整代号；不知道就输出 UNKNOWN。不要查文件。`;
  const sessionId = `replay-${input.scenario}-${input.variant}-${input.arm}`;
  const started = performance.now();
  try {
    const result = await executeAgentRuntime(
      {
        prompt,
        dir: activeDir,
        sessionSelection: { mode: "new", sessionId },
        provider: model.provider,
        modelRouteId: model.route.id,
        baseURL: model.config.baseURL,
        apiKey: model.config.apiKey,
        model: model.config.model,
        modelCapabilities: model.route.capabilities,
        allowedTools: ["memory_search"],
        permissionMode: "ask",
      },
      {
        picoHome,
        maxTurns: 8,
        signal: AbortSignal.timeout(90_000),
        modelRouter: model.runtime.router,
        provider,
        reporter: new SilentReporter(),
        memoryTrustStore: trust,
      },
    );
    const first = requests[0] ?? [];
    const memoryBlocks = first
      .filter((message) => message.content.includes("<atomic-memory-reference"))
      .map((message) => message.content);
    const toolCalls = requests.flatMap((messages) =>
      messages.flatMap((message) => message.toolCalls ?? []),
    );
    const answer = result.finalMessage.trim();
    const report = {
      scenario: input.scenario,
      variant: input.variant,
      arm: input.arm,
      schema: modern ? 16 : 15,
      seed: "controlled frozen evidence fixture",
      route: model.route.id,
      promptHash: createHash("sha256").update(prompt).digest("hex"),
      frozenAt: input.frozenAt,
      sourceFreezeDigest,
      marker: input.marker,
      initialMemoryContainsMarker: memoryBlocks.some((block) => block.includes(input.marker)),
      anyRequestContainsMarker: requests.some((messages) =>
        messages.some((message) => message.content.includes(input.marker)),
      ),
      answer,
      answerContainsMarker: answer.includes(input.marker),
      modelCalls: requests.length,
      usage: { ...result.usage, costCNY: null, costStatus: "unpriced" },
      providerLedger: providerLedger(input),
      learningDuringComparison: false,
      requestMemoryBlocks: memoryBlocks,
      inputCharacters: requests.reduce(
        (sum, messages) => sum + messages.reduce((n, message) => n + message.content.length, 0),
        0,
      ),
      elapsedMs: Math.round(performance.now() - started),
      toolNames: [...new Set(toolCalls.map((call) => call.name))],
      caseSearch: toolCalls.some((call) => {
        try {
          return call.name === "memory_search" && JSON.parse(call.arguments).record_type === "case";
        } catch {
          return false;
        }
      }),
      caseReferenceDelivered: requests.some((messages) =>
        messages.some(
          (message) =>
            message.content.includes('<task-case-reference trust="low">') &&
            message.content.includes(input.marker),
        ),
      ),
      adoption: "unknown unless separately supported by recorded tool effects",
      validation: "unknown for generic method",
    };
    await writeFile(
      input.reportPath,
      JSON.stringify({ ...report, status: "observed" }, null, 2) + "\n",
    );
    assert.ok(
      report.toolNames.every((name) => name === "memory_search"),
      "memory cannot grant additional tools",
    );
    if (input.arm === "off" || input.scenario === "scope")
      assert.equal(
        report.initialMemoryContainsMarker,
        false,
        "disabled or other-workspace memory leaked",
      );
    if (input.scenario === "case" && modern)
      assert.equal(report.initialMemoryContainsMarker, false, "case was automatically injected");
    if (input.scenario === "expired" && modern)
      assert.equal(report.initialMemoryContainsMarker, false, "expired method was injected");
    if (input.scenario === "correction")
      assert.ok(
        !memoryBlocks.some((block) => block.includes(`OLD_${input.marker}`)),
        "corrected old fact leaked",
      );
    if (["fact", "correction"].includes(input.scenario) && input.arm !== "off")
      assert.equal(answer, input.marker, "factual recall outcome differs");
    if (
      input.scenario === "scope" ||
      (["fact", "correction", "case"].includes(input.scenario) && input.arm === "off")
    )
      assert.equal(answer, "UNKNOWN", "unknown outcome must not be invented");
    if (input.scenario === "method" && input.arm === "new")
      assert.equal(
        report.initialMemoryContainsMarker,
        true,
        "matching generic method was not delivered",
      );
    if (input.scenario === "case" && input.arm === "new") {
      assert.equal(report.caseSearch, true, "explicit case lookup was not performed");
      assert.equal(
        report.caseReferenceDelivered,
        true,
        "case source fragment was not sent to the Provider",
      );
      assert.equal(
        report.answerContainsMarker,
        true,
        "case lookup did not recover its actual outcome",
      );
    }
    await writeFile(
      input.reportPath,
      JSON.stringify({ ...report, status: "passed" }, null, 2) + "\n",
    );
  } finally {
    await globalSessionManager.delete(sessionId, activeDir, { picoHome })?.close();
  }
}

if (process.argv[2]) {
  const input = JSON.parse(await readFile(process.argv[2], "utf8")) as ReplayInput;
  const started = performance.now();
  try {
    await run(input);
  } catch (error) {
    let observed: Record<string, unknown> = {};
    try {
      observed = JSON.parse(await readFile(input.reportPath, "utf8")) as Record<string, unknown>;
    } catch {
      /* failure before the first observed result */
    }
    const detail = redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ).slice(0, 8000);
    await mkdir(dirname(input.reportPath), { recursive: true });
    await writeFile(
      input.reportPath,
      JSON.stringify(
        {
          scenario: input.scenario,
          variant: input.variant,
          arm: input.arm,
          marker: input.marker,
          frozenAt: input.frozenAt,
          seed: "controlled frozen memory fixture, not natural learning",
          ...observed,
          status: "failed",
          failure: detail,
          elapsedMs: observed.elapsedMs ?? Math.round(performance.now() - started),
          usage: observed.usage ?? null,
          providerLedger: providerLedger(input),
        },
        null,
        2,
      ) + "\n",
    );
    throw new Error(`replay ${input.scenario}-${input.variant}-${input.arm}: ${detail}`);
  }
}
