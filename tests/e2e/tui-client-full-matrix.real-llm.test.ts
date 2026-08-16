import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { ApprovalNotice } from "../../src/approval/manager.js";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
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
 * textAnswer 回流模型）；⑤ prompt.cancel（模型收到 cancelled）；⑥ 审批
 * wire 真机（default 模式编辑触发 → diff/sessionScope/providerCallId 到达
 * 客户端 → allow_session 授权 → 同类编辑免审复用）；⑦ 图片附件端到端
 * （客户端附件 → 协议 wire → daemon commit → 模型视觉识别）。
 *
 * 隔离边界（2026-08-16 修订）：每场景独立临时 pico-home + 专属 daemon
 * （runtimeHostRootPath），不再共用用户常驻 daemon——失败轮次的 unregister
 * 清理同样失败会在真 home 注册表累积死条目（实测 118 条），把常驻 daemon
 * 拖进 cron 忙循环并让 workspace.list 超操作 deadline（"间歇死锁"根因）。
 * 结束 session.delete + trust(false) + unregister + 优雅关停专属 daemon。
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
  const picoHome = join(root, "pico-home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspaceDir = await realpath(workspaceSeed);
  const previousPicoHome = process.env.PICO_HOME;
  process.env.PICO_HOME = picoHome;
  t.after(async () => {
    if (previousPicoHome === undefined) delete process.env.PICO_HOME;
    else process.env.PICO_HOME = previousPicoHome;
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  // 关停专属 daemon：candidate 持常驻 residency 不 idle 自退，不关停会泄漏进程
  // （真 home 之外的 temp root 孤儿 daemon 正是这么来的）。注册顺序保证在
  // RPC 清理之后、client.close 之前执行（t.after LIFO）。
  t.after(() => stopScenarioDaemon(client, picoHome));
  t.after(() => client.close());
  // 冷启动排水：专属 daemon 每场景冷启动（19-31s 环境），ping 在幂等重试
  // 白名单内（30s 时间预算自动重试），先排水到就绪再 register。
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

    // /changes 单文件恢复真机链（tier2 收口）：fork 会话上第三回合让模型真实
    // 写文件 → checkpoint 追踪该文件 → rewind.changes 逐文件 diff + 指纹 →
    // restoreFile 单文件还原（created → 恢复=删除）。
    assert.ok(
      await sendAndDrain(
        runtime,
        reporter,
        "请使用 write_file 工具在当前工作目录创建文件 matrix-changes.txt，内容为一行 hello。",
      ),
      "回合三（写文件）应完成",
    );
    const changedFile = join(workspaceDir, "matrix-changes.txt");
    const fileCreated = await waitForCondition(() => existsSync(changedFile), 30_000);
    assert.ok(fileCreated, "模型应已真实写入 matrix-changes.txt（确定性锚点=文件存在）");

    const listAfter = await client.request("rewind.list", {
      workspacePath: workspaceDir,
      sessionId: applied.sessionId,
    });
    const checkpointsAfter = listAfter.checkpoints as unknown as { checkpointId: string }[];
    const third = checkpointsAfter[checkpointsAfter.length - 1]!;
    const changesResult = await client.request("rewind.changes", {
      workspacePath: workspaceDir,
      sessionId: applied.sessionId,
      checkpointId: third.checkpointId,
    });
    const entry = (
      changesResult.files as unknown as { path: string; fingerprint: string }[]
    ).find((file) => file.path.endsWith("matrix-changes.txt"));
    assert.ok(entry, `rewind.changes 应列出该文件（实际 ${JSON.stringify(changesResult.files)}）`);
    const restored = await client.request("rewind.restoreFile", {
      workspacePath: workspaceDir,
      sessionId: applied.sessionId,
      checkpointId: third.checkpointId,
      path: entry!.path,
      expectedFingerprint: entry!.fingerprint,
    });
    assert.equal(restored.restored, true, "单文件恢复应成功");
    const fileGone = await waitForCondition(() => !existsSync(changedFile), 30_000);
    assert.ok(fileGone, "created 文件的恢复语义 = 还原到消息之前（文件消失）");

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

realModelTest(
  "matrix e2e 6: 审批 wire diff/sessionScope 真机 + allow_session 会话授权复用",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    const targetFile = join(workspaceDir, "approval-e2e.txt");
    await writeFile(targetFile, "alpha\n", "utf8");

    const reporter = new TuiReporter();
    const approvals: ApprovalNotice[] = [];
    const approvalsResolved: string[] = [];
    const runtime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      reporter,
      onApproval: (notice) => approvals.push(notice),
      onApprovalResolved: (approvalId) => approvalsResolved.push(approvalId),
    });
    await runtime.start();

    // 建会话回合（不锁模型字面输出，等 assistant + idle 双信号排水）。
    let accepted = await runtime.sendText("请只回复两个字符：ok");
    if (!accepted) accepted = await runtime.sendText("请只回复两个字符：ok");
    assert.ok(accepted, "建会话 session.send 应被接受");
    scenario.trackSession(runtime.activeSessionId);
    const drained = await waitForCondition(
      () =>
        !runtime.running &&
        reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
      180_000,
    );
    assert.ok(drained, "建会话回合应完成");
    const sessionId = runtime.activeSessionId;
    assert.ok(sessionId, "建会话回合应确立 sessionId");
    // 收紧权限模式：default 下 write/edit 一律审批（引擎 isAgentOpsDangerousCommand）。
    await client.request("session.settings.update", {
      workspacePath: workspaceDir,
      sessionId,
      permissionMode: "default",
    });

    // 第一回合：模型编辑文件 → approval.requested 到达客户端，wire 应带
    // providerCallId/diff/sessionScope（3-D 漏账补齐的端到端验证）。
    approvals.length = 0;
    let sent = await runtime.sendText(
      "请用 edit_file 工具把 approval-e2e.txt 中的 alpha 改为 beta（不要用 bash），完成后只回复：done",
    );
    if (!sent) sent = await runtime.sendText("请按上一条指示用 edit_file 修改 approval-e2e.txt。");
    assert.ok(sent, "编辑回合 session.send 应被接受");
    const approvalArrived = await waitForCondition(() => approvals.length > 0, 180_000);
    assert.ok(approvalArrived, "default 模式下文件编辑应触发审批");
    const notice = approvals[0]!;
    assert.ok(
      notice.toolName === "edit_file" || notice.toolName === "write_file",
      `应为文件编辑工具（实际 ${notice.toolName}）`,
    );
    assert.ok(notice.providerCallId, "wire 应携带 providerCallId（漏账补齐：工具卡精确匹配）");
    assert.ok(notice.diff?.includes("beta"), `wire 应携带含新内容的 diff（实际：${notice.diff}`);
    assert.ok(notice.sessionScope, "wire 应携带 sessionScope（第三选项渲染依据）");
    const scope = notice.sessionScope as Record<string, unknown>;
    assert.ok(
      scope["type"] === "all-edits" ||
        scope["type"] === "file" ||
        scope["type"] === "directories",
      `编辑类 sessionScope 形状（实际 ${String(scope["type"])}）`,
    );

    // allow_session：结构化授权入会话 → 本回合放行 → 文件落地 → resolved 事件。
    assert.equal(await runtime.resolvePlain("approve-session", notice.taskId), true);
    const firstDone = await waitForCondition(() => !runtime.running, 180_000);
    assert.ok(firstDone, "批准后回合应终态");
    const content1 = await readFile(targetFile, "utf8");
    assert.ok(content1.includes("beta"), `文件应完成第一次修改（实际 ${content1}）`);
    assert.ok(approvalsResolved.includes(notice.taskId), "approval.resolved 应到达客户端");

    // 第二回合：同类编辑不再触发审批——session grant 复用是 sessionScope 语义闭环。
    approvals.length = 0;
    approvalsResolved.length = 0;
    let second = await runtime.sendText(
      "再用 edit_file 把 approval-e2e.txt 中的 beta 改为 gamma（不要用 bash），完成后只回复：done",
    );
    if (!second) second = await runtime.sendText("请按上一条指示继续修改 approval-e2e.txt。");
    assert.ok(second, "第二回合 session.send 应被接受");
    const secondDone = await waitForCondition(
      async () => !runtime.running && (await readFile(targetFile, "utf8")).includes("gamma"),
      180_000,
    );
    assert.ok(secondDone, "第二回合应完成且文件更新为 gamma");
    assert.equal(approvals.length, 0, "allow_session 后同类编辑不应再触发审批（会话授权复用）");

    runtime.dispose();
  },
);

realModelTest(
  "matrix e2e 7: 图片附件端到端——客户端附件 → 协议 wire → daemon commit → 模型确认收到图",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const scenario = await createScenarioWorkspace(t);
    const { client, workspaceDir } = scenario;
    const reporter = new TuiReporter();
    const runtime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      reporter,
    });
    await runtime.start();

    // 64x64 纯红 PNG（RGB(220,20,20)，base64 仅 240 字符——纯色高压缩）——
    // 经 sendText 附件通道上送。断言语义：附件在客户端 wire → 协议参数门 →
    // daemon user message commit → 模型请求全链路不破坏回合，且模型确认
    // "被问及一张图"（不能断言识别正确色——本端点视觉管线有损：裸探同图
    // claude-sonnet-4-5 答"橄榄绿"，网关会把内联图转成托管 URL；pico 侧图
    // 已到达网关由其上传行为证实，见 handoff 环境注）。
    const RED_PNG =
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==";
    let accepted = await runtime.sendText(
      "附件是一张纯色小图片。不要使用任何工具，直接回答它是什么颜色，只回答颜色名。",
      "auto",
      [{ type: "image_base64", mimeType: "image/png", data: RED_PNG }],
    );
    if (!accepted) accepted = await runtime.sendText("请直接回答附件图片的颜色。");
    assert.ok(accepted, "带附件的 session.send 应被接受");
    scenario.trackSession(runtime.activeSessionId);

    const answered = await waitForCondition(
      () =>
        !runtime.running &&
        reporter.getProjection().entries.some(({ entry }) => entry.kind === "assistant"),
      180_000,
    );
    assert.ok(answered, "带附件回合应正常终态（附件不破坏链路）");
    const assistantText = reporter
      .getProjection()
      .entries.filter(({ entry }) => entry.kind === "assistant")
      .map(({ entry }) => JSON.stringify(entry))
      .join("\n");
    assert.match(
      assistantText,
      /色|图|image|color/iu,
      `模型应确认被问及图片（附件需真实进入模型请求；实际回复：${assistantText.slice(0, 200)}`,
    );

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

/** 优雅关停场景专属 daemon；无注册（从未拉起）时直接跳过，绝不反向拉起。 */
async function stopScenarioDaemon(client: LocalRuntimeClient, picoHome: string): Promise<void> {
  let pid: number | undefined;
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    const registration = await readHostRegistration(
      join(resolveRootControlNamespace(), capability.rootId),
    );
    pid = registration?.pid;
  } catch {
    // 控制目录不可读 = daemon 未运行。
  }
  if (pid === undefined) return;
  try {
    await client.shutdownDaemon();
    return;
  } catch {
    // 优雅路径失败（连接已死等）退回硬杀。
  }
  try {
    process.kill(pid);
  } catch {
    // 已退出。
  }
}
