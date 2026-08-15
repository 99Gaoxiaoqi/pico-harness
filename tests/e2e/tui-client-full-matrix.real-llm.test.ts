import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { LocalRuntimeClient } from "../../src/daemon/index.js";
import {
  ClientSessionRuntime,
  type ClientPromptRequest,
} from "../../src/tui/client-session-runtime.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { diffStatFromRewindPreview } from "../../src/tui/rewind-client-bridge.js";

/**
 * 3-D Phase 4 全方位真机矩阵：默认客户端路径 + Phase 3 收口全部新能力的
 * 真实 daemon + 真实模型验证（RUN_LLM_E2E 门）。
 *
 * 覆盖：① BYOK --model 路由覆盖 + --graph 启动覆盖（settings 真实落地）；
 * ② --continue/--fork 会话水化（fork 保原会话）；③ /rewind 真机链路
 * （list → preview 指纹 → apply conversation 模式 → fork 切换）；④ ask_user
 * 自由文本真机（模型真实调用工具 → prompt.requested → respond 文本 →
 * textAnswer 回流模型）；⑤ prompt.cancel（模型收到 cancelled）。
 *
 * 隔离边界与清理同 tui-client-tracer.real-llm.test.ts：临时工作区注册/信任，
 * 结束 session.delete + trust(false) + unregister；不杀常驻 daemon。
 */

const TEST_TIMEOUT_MS = 10 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

interface ScenarioWorkspace {
  readonly client: LocalRuntimeClient;
  readonly workspaceDir: string;
  trackSession(sessionId: string | undefined): void;
}

async function createScenarioWorkspace(t: import("node:test").TestContext): Promise<ScenarioWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "pico-matrix-e2e-"));
  const workspaceSeed = join(root, "workspace");
  await mkdir(workspaceSeed, { recursive: true });
  const workspaceDir = await realpath(workspaceSeed);
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  const client = new LocalRuntimeClient();
  t.after(() => client.close());
  // 冷启动排水：daemon 可能因上一轮 e2e 结束而 idle 自退，connectOrSpawn 拉起
  // 慢（19-31s）期间非幂等请求会失败——ping 在幂等重试白名单内（30s 时间预算
  // 自动重试），先排水到就绪再 register。runtime.ping 是 EmptyParams。
  await client.request("runtime.ping", {});
  await client.request("workspace.register", { workspacePath: workspaceDir });
  await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });
  let trackedSessionId: string | undefined;
  t.after(async () => {
    if (trackedSessionId) {
      await client
        .request("session.delete", { workspacePath: workspaceDir, sessionId: trackedSessionId })
        .catch(() => undefined);
    }
    await client
      .request("workspace.trust", { workspacePath: workspaceDir, trusted: false })
      .catch(() => undefined);
    await client
      .request("workspace.unregister", { workspacePath: workspaceDir })
      .catch(() => undefined);
  });
  return {
    client,
    workspaceDir,
    trackSession: (sessionId) => {
      if (sessionId) trackedSessionId = sessionId;
    },
  };
}

/** 发送并等真实回合终态：等投影出现 assistant 回复（真完成信号）+ 回到 idle
 * （含 resend 双回合排水——第二回合也是同文，同样产出 assistant）。 */
async function sendAndDrain(
  runtime: ClientSessionRuntime,
  reporter: TuiReporter,
  text: string,
): Promise<boolean> {
  let accepted = await runtime.sendText(text);
  if (!accepted) accepted = await runtime.sendText(text);
  if (!accepted) return false;
  const answered = await waitForCondition(
    () =>
      reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
    180_000,
  );
  if (!answered) return false;
  return waitForCondition(() => !runtime.running, 180_000);
}

realModelTest(
  "matrix e2e 1: BYOK --model 路由覆盖与 --graph 启动覆盖真实落地",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    // 用 daemon 真实默认路由作为 --model 值（验证覆盖桥而非指定任意路由）。
    const { config } = await client.request("config.effective.get", { workspacePath: workspaceDir });
    assert.ok(config.defaultModelRouteId, "daemon 应配置默认路由");
    const route = config.defaultModelRouteId;

    const reporter = new TuiReporter();
    const overlayErrors: string[] = [];
    const originalPushError = reporter.pushError.bind(reporter);
    reporter.pushError = ((message: string, context?: unknown) => {
      overlayErrors.push(
        `${message}${context instanceof Error ? ` (${context.message})` : ""}`,
      );
      return originalPushError(message, context as never);
    }) as typeof reporter.pushError;
    const runtime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      reporter,
      modelOverride: route,
      orchestrationModeOverride: "graph",
    });
    await runtime.start();
    scenario.trackSession(runtime.activeSessionId);

    assert.ok(
      await sendAndDrain(runtime, reporter, "请只回复两个字符：ok"),
      "真实回合应终态（sessionId 确立后启动覆盖已应用）",
    );
    scenario.trackSession(runtime.activeSessionId);
    // 覆盖应用经"回合终态重试"（sendInput 后 run 注册窗口内的 CONFLICT 由
    // onRunStateChanged(false) 触发重试覆盖）——终态断言用有界轮询等生效。
    const overrideApplied = await waitForCondition(
      async () => {
        const { settings } = await client.request("session.settings.get", {
          workspacePath: workspaceDir,
          sessionId: runtime.activeSessionId ?? "",
        });
        return settings.modelRouteId === route && settings.orchestrationMode === "graph";
      },
      30_000,
    );
    assert.ok(
      overrideApplied,
      `--model/--graph 覆盖应最终写入会话设置（覆盖错误：${overlayErrors.join(" | ") || "无"}）`,
    );
    runtime.dispose();
  },
);

realModelTest(
  "matrix e2e 2: --continue 水化与 --fork 保原会话",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    const reporter = new TuiReporter();
    const runtime = new ClientSessionRuntime({ client, workspacePath: workspaceDir, reporter });
    await runtime.start();
    assert.ok(await sendAndDrain(runtime, reporter, "请只回复两个字符：ok"), "首回合应完成");
    const sourceSessionId = runtime.activeSessionId!;
    scenario.trackSession(sourceSessionId);
    runtime.dispose();

    // --fork：经 session.fork RPC（Phase 4 forkFrom 桥的后端）切新会话，原会话不动。
    const forked = await client.request("session.fork", {
      workspacePath: workspaceDir,
      sessionId: sourceSessionId,
    });
    assert.notEqual(forked.session.sessionId, sourceSessionId);
    scenario.trackSession(forked.session.sessionId);

    // --continue（等价：以最新会话 id resume）→ 水化应看到 fork 自源会话的
    // 真实回合。断言用 assistant 存在性 + 与源回复内容一致（模型输出字面值
    // 不稳定——"请只回复 ok"实测会回"好的。"，includes("ok") 是间歇假失败）。
    const sourceAssistant = reporter
      .getProjection()
      .entries.map(({ entry }) => entry)
      .find((entry) => entry.kind === "assistant");
    assert.ok(sourceAssistant, "源会话应有 assistant 回复");
    const forkReporter = new TuiReporter();
    const forkRuntime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      sessionId: forked.session.sessionId,
      reporter: forkReporter,
    });
    await forkRuntime.start();
    const hydrated = await waitForCondition(
      () =>
        forkReporter
          .getProjection()
          .entries.some(
            ({ entry }) =>
              entry.kind === "assistant" && entry.content === sourceAssistant.content,
          ),
      60_000,
    );
    if (!hydrated) {
      const forkEntries = forkReporter
        .getProjection()
        .entries.map(
          ({ entry }) => `${entry.kind}:${(entry as { content?: string }).content?.slice(0, 30) ?? ""}`,
        );
      assert.fail(
        `fork 会话水化应含源会话回复（源=${sourceAssistant.content.slice(0, 40)}；fork 投影=[${forkEntries.join(" | ")}]）`,
      );
    }
    // 原会话仍存在且独立（fork 非破坏）。
    const original = await client.request("session.get", {
      workspacePath: workspaceDir,
      sessionId: sourceSessionId,
    });
    assert.equal(original.session.sessionId, sourceSessionId, "源会话不受 fork 影响");
    forkRuntime.dispose();
  },
);

realModelTest(
  "matrix e2e 3: /rewind 真机链路——list → preview 指纹 → conversation fork 切换",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    const reporter = new TuiReporter();
    const runtime = new ClientSessionRuntime({ client, workspacePath: workspaceDir, reporter });
    const registry = createClientCommandRegistry({ runtime, workspacePath: workspaceDir });
    await runtime.start();
    // 两个真实回合 → 至少两个 user-message checkpoint。
    assert.ok(await sendAndDrain(runtime, reporter, "请只回复：一号"), "回合一应完成");
    assert.ok(await sendAndDrain(runtime, reporter, "请只回复：二号"), "回合二应完成");
    const sessionId = runtime.activeSessionId!;
    scenario.trackSession(sessionId);

    // /rewind 命令真实链路：rewind.list + 选择器数据（execute 内已完成
    // RPC→FileHistorySnapshotSummary 映射，此处直接消费）。
    const rewind = await processClientInput("/rewind", registry, runtime);
    assert.equal(rewind.kind, "local");
    assert.equal(
      (rewind.result?.ui as { selector?: string } | undefined)?.selector,
      "rewind",
    );
    const snapshots = (rewind.result?.data as { snapshots?: { messageId: string }[] })
      .snapshots ?? [];
    assert.ok(snapshots.length >= 2, `应有 ≥2 个 checkpoint（实际 ${snapshots.length}）`);
    // rewind 语义 = "restore to the point before you sent this message"：选最新
    // checkpoint（二号）→ fork 后保留一号回合、不含二号。
    const target = snapshots[snapshots.length - 1]!;

    // preview → fingerprint → apply（conversation 模式不动文件，非破坏 fork）。
    const previewResult = await client.request("rewind.preview", {
      workspacePath: workspaceDir,
      sessionId,
      checkpointId: target.messageId,
    });
    const preview = diffStatFromRewindPreview(previewResult, target.messageId);
    assert.ok(preview.fingerprint, "preview 应返回指纹");
    const applied = await client.request("rewind.apply", {
      workspacePath: workspaceDir,
      sessionId,
      checkpointId: target.messageId,
      expectedFingerprint: preview.fingerprint,
      mode: "conversation",
    });
    assert.equal(applied.applied, true);
    assert.notEqual(applied.sessionId, sessionId, "rewind 应 fork 出新会话");
    scenario.trackSession(applied.sessionId);

    // fork 切换 + 水化（Phase 4 rewind 桥的 switchSession 语义）：conversation
    // 语义用 user 消息边界断言（发送文本确定性；assistant 字面值不稳定）——
    // 保留一号回合、不含二号。
    await runtime.switchSession(applied.sessionId);
    const forkHydrated = await waitForCondition(
      () =>
        reporter
          .getProjection()
          .entries.some(({ entry }) => entry.kind === "user" && entry.content.includes("一号")),
      60_000,
    );
    assert.ok(forkHydrated, "conversation fork 水化应含回滚点之前的用户回合（一号）");
    assert.ok(
      !reporter
        .getProjection()
        .entries.some(({ entry }) => entry.kind === "user" && entry.content.includes("二号")),
      "回滚点之后的用户回合（二号）不应出现",
    );
    assert.ok(
      reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
      "fork 会话应保留真实模型回复",
    );
    runtime.dispose();
  },
);

realModelTest(
  "matrix e2e 4: ask_user 自由文本真机——模型真实提问 → 文本回答回流 → cancel",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    const reporter = new TuiReporter();
    const prompts: ClientPromptRequest[] = [];
    const resolvedPromptIds: string[] = [];
    const runtime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      reporter,
      onPrompt: (request) => prompts.push(request),
      onPromptResolved: (promptId) => resolvedPromptIds.push(promptId),
    });
    await runtime.start();

    // 自由文本提问：模型按指示调用 ask_user（freeText、无 options）。
    let accepted = await runtime.sendText(
      "请调用 ask_user 工具向我提问：question 设为「你最喜欢的水果是什么？」，freeText 设为 true，不要提供 options。拿到我的回答后，用一句话复述我的回答。",
    );
    if (!accepted) accepted = await runtime.sendText("请按上一条指示调用 ask_user 工具提问。");
    assert.ok(accepted, "session.send 应被接受");
    scenario.trackSession(runtime.activeSessionId);

    const asked = await waitForCondition(() => prompts.length > 0, 180_000);
    assert.ok(asked, "模型应真实调用 ask_user（prompt.requested 到达客户端）");
    const prompt = prompts[0]!;
    assert.equal(prompt.freeText, true, "请求应声明 freeText");
    assert.deepEqual(prompt.options, [], "按指示不带选项");
    assert.ok(prompt.question.includes("水果"), `问题文本应含水果（实际：${prompt.question}）`);

    // 自由文本回答 → prompt.respond → textAnswer 回流模型 → 回合终态（复述
    // 用词不稳定，断言回合完成 + prompt resolved；文本回流已由 respond accepted 覆盖）。
    assert.equal(await runtime.respondPrompt(prompt.requestId, "苹果和梨"), true);
    const answeredTurn = await waitForCondition(
      () =>
        !runtime.running &&
        reporter
          .getProjection()
          .entries.some(({ entry }) => entry.kind === "assistant"),
      180_000,
    );
    assert.ok(answeredTurn, "模型应拿到自由文本回答并完成回合");
    assert.ok(
      resolvedPromptIds.includes(prompt.requestId),
      "prompt.resolved 应到达（对话框收口链路）",
    );

    // cancel 路径：再次提问后经 prompt.cancel RPC 取消（模型收到 cancelled）。
    prompts.length = 0;
    let second = await runtime.sendText(
      "再调用一次 ask_user 工具：question 设为「第二个问题」，freeText=true，无 options。如果用户取消就只回复两个字：收到。",
    );
    if (!second) second = await runtime.sendText("请按上一条指示再调用一次 ask_user。");
    assert.ok(second);
    const askedAgain = await waitForCondition(() => prompts.length > 0, 180_000);
    assert.ok(askedAgain, "第二次提问应到达");
    const secondPrompt = prompts[0]!;
    const cancelled = await client.request("prompt.cancel", {
      workspacePath: workspaceDir,
      promptId: secondPrompt.requestId,
    });
    assert.equal(cancelled.cancelled, true, "prompt.cancel 应取消 pending 问题");
    const cancelSettled = await waitForCondition(() => !runtime.running, 180_000);
    assert.ok(cancelSettled, "取消后回合应终态");
    runtime.dispose();
  },
);

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
