import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import type { Message } from "../../src/schema/message.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";
import { AskUserHandler } from "../../src/tools/ask-user.js";
import { configuredUserDefaultRealModel, type RealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

interface TestSandbox {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly sessionId: string;
}

realModelTest(
  "real plan mode investigates read-only, proposes a plan, and stops at handoff",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("proposal");
    context.after(() => cleanupSandbox(sandbox));
    await writeFile(
      join(sandbox.workDir, "calculator.ts"),
      "export function add(left: number, right: number): number { return left + right; }\n",
      "utf8",
    );
    const before = await workspaceHashes(sandbox.workDir);
    const systems: string[] = [];

    const result = await new AgentRuntime().execute(
      planningRequest(
        sandbox,
        model,
        [
          "先使用 read_file 调查 calculator.ts，再为新增 subtract 函数制定实施计划。",
          "审批前绝对不要修改任何文件；完成后必须且只能调用一次 submit_plan。",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model, { systems }),
    );

    assert.equal(result.handoff?.kind, "plan_handoff");
    assert.ok(result.handoff?.projection.pendingProposal?.steps.length);
    const events = await readRuntimeEvents(sandbox);
    assert.equal(events.filter((event) => event.kind === "plan.proposed").length, 1);
    assert.equal(toolCalls(events, "submit_plan").length, 1);
    assert.ok(
      events.some(
        (event) =>
          event.kind === "tool.result.recorded" &&
          event.data.status === "succeeded" &&
          ["read_file", "grep", "glob", "repo_map"].includes(event.data.toolName),
      ),
      "planning must contain a successful read/search tool fact",
    );
    assertMainModelSucceeded(events);
    assert.equal(
      events.findLast((event) => event.kind === "run.terminal")?.data.status,
      "completed",
    );
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
    assert.ok(systems.some(isPlanSystemPrompt));
  },
);

realModelTest(
  "real plan mode approves with CAS and executes the approved plan in a new run",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("execute");
    context.after(() => cleanupSandbox(sandbox));
    const canary = `PICO_PLAN_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    await writeFile(
      join(sandbox.workDir, "TASK.txt"),
      `Create canary.txt containing exactly ${canary} followed by one newline.\n`,
      "utf8",
    );
    const systems: string[] = [];
    const runtime = new AgentRuntime();
    const planned = await runtime.execute(
      planningRequest(
        sandbox,
        model,
        [
          "Read TASK.txt and produce a one-step implementation plan.",
          "Do not create canary.txt before approval. Finish by calling submit_plan exactly once.",
        ].join("\n"),
        "new",
      ),
      runtimeHost(sandbox, model, { systems }),
    );
    const handoff = planned.handoff;
    assert.ok(handoff);
    await assert.rejects(readFile(join(sandbox.workDir, "canary.txt"), "utf8"), /ENOENT/u);

    const executed = await runtime.approvePlanAndExecute(
      {
        approval: {
          sessionId: sandbox.sessionId,
          dir: sandbox.workDir,
          planId: handoff.planId,
          expectedRevision: handoff.revision,
          expectedSessionSequence: handoff.expectedSessionSequence,
          operationId: `approve:${randomUUID()}`,
        },
        execution: {
          ...modelRequest(model),
          sessionSelection: { mode: "resume", sessionId: sandbox.sessionId },
          interactionMode: "yolo",
          allowedTools: ["read_file", "write_file", "update_plan", "cancel_plan"],
        },
      },
      runtimeHost(sandbox, model, { systems }),
    );

    assert.equal(executed.handoff, undefined);
    assert.equal(await readFile(join(sandbox.workDir, "canary.txt"), "utf8"), `${canary}\n`);
    const events = await readRuntimeEvents(sandbox);
    const approvedIndex = events.findIndex((event) => event.kind === "plan.approved");
    const firstWriteIndex = events.findIndex(
      (event) => event.kind === "tool.started" && event.data.toolName === "write_file",
    );
    assert.ok(approvedIndex >= 0 && firstWriteIndex > approvedIndex);
    assert.equal(events.filter((event) => event.kind === "run.started").length, 2);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 2);
    assert.equal(
      events.some((event) => event.kind === "plan.execution.started"),
      true,
    );
    assert.equal(
      events.some((event) => event.kind === "plan.execution.completed"),
      true,
    );
    assert.equal(systems.filter(isPlanSystemPrompt).length >= 1, true);
    assert.equal(isPlanSystemPrompt(systems.at(-1) ?? ""), false);
    assertMainModelSucceeded(events);
  },
);

realModelTest(
  "real plan mode asks for a choice and submits a stale-safe second revision after feedback",
  { timeout: TEST_TIMEOUT_MS },
  async (context) => {
    const model = await configuredUserDefaultRealModel();
    const sandbox = await createSandbox("revision");
    context.after(() => cleanupSandbox(sandbox));
    await writeFile(join(sandbox.workDir, "config.txt"), "format=unset\n", "utf8");
    const before = await workspaceHashes(sandbox.workDir);
    const askUserHandler = new AskUserHandler();
    let answered = 0;
    askUserHandler.subscribe((event) => {
      if (event.kind !== "pending") return;
      const option =
        event.request.options.find((candidate) => /json/iu.test(candidate.label)) ??
        event.request.options[0];
      if (!option) throw new Error("ask_user did not provide an option");
      answered++;
      queueMicrotask(() => askUserHandler.select(event.request.requestId, option.optionId));
    });
    const runtime = new AgentRuntime();
    const first = await runtime.execute(
      planningRequest(
        sandbox,
        model,
        [
          "Read config.txt. Before planning, you must call ask_user once to choose JSON or YAML.",
          "After the answer, submit a plan for implementing that format. Do not modify files.",
        ].join("\n"),
        "new",
        true,
      ),
      runtimeHost(sandbox, model, { askUserHandler }),
    );
    assert.equal(answered, 1);
    const firstEvents = await readRuntimeEvents(sandbox);
    assert.equal(first.handoff?.revision, 1, planEventSummary(firstEvents));

    const revisionOperationId = `revise:${randomUUID()}`;
    const revisionRequest = await runtime.requestPlanRevision({
      sessionId: sandbox.sessionId,
      dir: sandbox.workDir,
      picoHome: sandbox.picoHome,
      planId: first.handoff!.planId,
      expectedRevision: first.handoff!.revision,
      expectedSessionSequence: first.handoff!.expectedSessionSequence,
      operationId: revisionOperationId,
      feedback: "改用 YAML，并新增一个验证 YAML 可解析的独立步骤。",
    });
    assert.equal(revisionRequest.replayed, false);
    assert.equal(revisionRequest.projection.pendingProposal, undefined);
    assert.equal(revisionRequest.projection.proposals[0]?.status, "stale");
    assert.equal(revisionRequest.projection.revisionRequest?.operationId, revisionOperationId);

    const second = await runtime.execute(
      planningRequest(
        sandbox,
        model,
        [
          "继续完成已持久化的计划修订请求。",
          "先查看现有上下文，再调用 submit_plan 提交修订版；不要修改工作区文件。",
        ].join("\n"),
        "resume",
      ),
      runtimeHost(sandbox, model, { askUserHandler }),
    );

    assert.equal(second.handoff?.revision, 2);
    const projection = second.handoff?.projection;
    assert.equal(projection?.proposals[0]?.status, "stale");
    assert.equal(projection?.pendingProposal?.revision, 2);
    assert.match(JSON.stringify(projection?.pendingProposal), /YAML/iu);
    assert.ok((projection?.pendingProposal?.steps.length ?? 0) >= 2);
    assert.ok(
      projection?.pendingProposal?.steps.some((step) => {
        const text = `${step.title}\n${step.description}`;
        return (
          /YAML/iu.test(text) && /(parse|parsable|validate|validation|解析|校验|验证)/iu.test(text)
        );
      }),
      "revision 2 must include an independent step that validates YAML parsing",
    );
    const events = await readRuntimeEvents(sandbox);
    assert.equal(events.filter((event) => event.kind === "plan.revision.requested").length, 1);
    assert.equal(events.filter((event) => event.kind === "plan.revised").length, 1);
    assert.equal(toolCalls(events, "ask_user").length, 1);
    assert.equal(toolCalls(events, "submit_plan").length, 2);
    assertMainModelSucceeded(events);
    assert.deepEqual(await workspaceHashes(sandbox.workDir), before);
  },
);

function planningRequest(
  sandbox: TestSandbox,
  model: RealModel,
  prompt: string,
  mode: "new" | "resume",
  includeAskUser = false,
): RunAgentCliOptions {
  return {
    ...modelRequest(model),
    prompt,
    dir: sandbox.workDir,
    sessionSelection: { mode, sessionId: sandbox.sessionId },
    interactionMode: "plan",
    allowedTools: [
      "read_file",
      "read_evidence",
      "glob",
      "grep",
      ...(includeAskUser ? ["ask_user"] : []),
      "submit_plan",
    ],
  };
}

function modelRequest(
  model: RealModel,
): Pick<
  RunAgentCliOptions,
  | "provider"
  | "baseURL"
  | "apiKey"
  | "model"
  | "modelRouteId"
  | "modelCapabilities"
  | "thinkingEffort"
> {
  return {
    provider: model.provider,
    baseURL: model.config.baseURL,
    apiKey: model.config.apiKey,
    model: model.config.model,
    modelRouteId: model.route.id,
    modelCapabilities: model.route.capabilities,
    ...(supportsThinkingOff(model.route) ? { thinkingEffort: "off" } : {}),
  };
}

function runtimeHost(
  sandbox: TestSandbox,
  model: RealModel,
  options: {
    readonly systems?: string[];
    readonly askUserHandler?: AskUserHandler;
  } = {},
): RunAgentCliDependencies {
  return {
    picoHome: sandbox.picoHome,
    env: process.env,
    modelRouter: model.runtime.router,
    reporter: new SilentReporter(),
    ...(options.askUserHandler ? { askUserHandler: options.askUserHandler } : {}),
    ...(options.systems ? { providerDecorator: captureSystemPrompts(options.systems) } : {}),
  };
}

function captureSystemPrompts(
  sink: string[],
): NonNullable<RunAgentCliDependencies["providerDecorator"]> {
  return (provider) => {
    const capture = (messages: readonly Message[]): void => {
      sink.push(messages.find((message) => message.role === "system")?.content ?? "");
    };
    const wrapped: LLMProvider = {
      ...(provider.modelName ? { modelName: provider.modelName } : {}),
      get requestCapabilities() {
        return provider.requestCapabilities;
      },
      generate: (messages, tools, options) => {
        capture(messages);
        return provider.generate(messages, tools, options);
      },
      ...(provider.generateStream
        ? {
            generateStream: (messages, tools, onDelta, options) => {
              capture(messages);
              return provider.generateStream!(messages, tools, onDelta, options);
            },
          }
        : {}),
    };
    return wrapped;
  };
}

function supportsThinkingOff(route: ModelRoute): boolean {
  const profile = route.capabilities.reasoningProfile;
  return profile.enabled === true && profile.levels.includes("off");
}

function isPlanSystemPrompt(value: string): boolean {
  return /Plan Mode|规划模式|submit_plan/u.test(value);
}

async function createSandbox(label: string): Promise<TestSandbox> {
  const root = await mkdtemp(join(tmpdir(), `pico-plan-real-${label}-`));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  return { root, workDir, picoHome, sessionId: `plan-real-${label}-${randomUUID()}` };
}

async function cleanupSandbox(sandbox: TestSandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true });
}

async function readRuntimeEvents(sandbox: TestSandbox): Promise<RuntimeEvent[]> {
  const store = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(sandbox.workDir, { picoHome: sandbox.picoHome }).workspace.root,
  });
  try {
    return await store.readSession(sandbox.sessionId);
  } finally {
    store.close();
  }
}

function toolCalls(events: readonly RuntimeEvent[], name: string): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.kind !== "message.committed") continue;
    for (const call of event.data.message.toolCalls ?? []) {
      if (call.name === name) ids.push(call.id);
    }
  }
  return ids;
}

function assertMainModelSucceeded(events: readonly RuntimeEvent[]): void {
  const mainCalls = new Set(
    events
      .filter(
        (event): event is Extract<RuntimeEvent, { kind: "model.call.started" }> =>
          event.kind === "model.call.started" && event.data.purpose === "main",
      )
      .map((event) => event.data.providerCallId),
  );
  assert.ok(mainCalls.size > 0);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "model.call.settled" &&
        event.data.status === "succeeded" &&
        mainCalls.has(event.data.providerCallId),
    ),
  );
}

function planEventSummary(events: readonly RuntimeEvent[]): string {
  const summary: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.kind === "tool.started") {
      summary.push({ kind: event.kind, tool: event.data.toolName });
    } else if (event.kind === "tool.result.recorded") {
      summary.push({ kind: event.kind, tool: event.data.toolName, status: event.data.status });
    } else if (event.kind === "model.call.settled") {
      summary.push({ kind: event.kind, status: event.data.status });
    } else if (event.kind === "run.terminal") {
      summary.push({ kind: event.kind, status: event.data.status });
    } else if (event.kind === "message.committed") {
      const tools = event.data.message.toolCalls?.map((call) => call.name) ?? [];
      if (tools.length > 0) summary.push({ kind: event.kind, tools });
    }
  }
  return JSON.stringify(summary);
}

async function workspaceHashes(workDir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        hashes[relative(workDir, path)] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  };
  await visit(workDir);
  return hashes;
}
