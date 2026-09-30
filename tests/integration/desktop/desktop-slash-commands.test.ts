import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClientCommandRegistry } from "@pico/cli/client-commands";
import { registerCommandIpc } from "../../../apps/desktop/src/main/command-ipc.js";
import { createCommandBridge } from "../../../apps/desktop/src/preload/command-bridge.js";
import { DESKTOP_COMMAND_CHANNEL } from "../../../apps/desktop/src/preload/command-contract.js";
import {
  DESKTOP_COMMAND_POLICY,
  desktopCommandPolicy,
} from "../../../apps/desktop/src/shared/command-policy.js";

test("桌面命令按显式范围分派，禁止管理别名绕过，保留类型化动作与发送幂等", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let active = false;
  const conflict = false;
  let revision = 1;
  let status = "active";
  let loseSendResponse = false;
  const admissions = new Set<unknown>();
  const goal = () => ({
    stateVersion: 3,
    currentGoal: {
      id: "g1",
      revision,
      status,
      condition: "完成验收",
      maxIterations: 50,
      iterations: 0,
      tokensAtStart: 0,
      tokensNow: 0,
    },
  });
  const session = (id: unknown) => ({
    sessionId: id,
    workspacePath: "/fixture",
    title: `会话 ${id}`,
    createdAt: 1,
    updatedAt: 2,
    status: "active",
  });
  const runtime = {
    async request(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "runs.list")
        return { runs: active ? [{ runId: "run-1", sessionId: "s1", status: "running" }] : [] };
      if (method === "goal.get") return { goal: goal() };
      if (method === "goal.control") {
        assert.equal(params.expectedRevision, revision);
        if (conflict) {
          revision++;
          throw Object.assign(new Error("stale"), { code: "CONFLICT" });
        }
        revision++;
        status = params.action === "pause" ? "paused" : "active";
        return { goal: goal() };
      }
      if (method === "session.list") return { sessions: [session("s1"), session("s2")] };
      if (method === "session.get") return { session: session(params.sessionId) };
      if (method === "session.fork")
        return { session: session("fork-1"), sourceSessionId: params.sessionId };
      if (method === "session.settings.get")
        return {
          settings: {
            collaborationMode: "agent",
            permissionMode: "ask",
            orchestrationMode: "default",
          },
        };
      if (method === "session.send") {
        admissions.add(params.idempotencyKey);
        if (loseSendResponse) {
          loseSendResponse = false;
          active = true;
          throw new Error("已接收，但响应丢失");
        }
        return { session: session(params.sessionId ?? "created-1"), disposition: "started" };
      }
      if (method === "session.rename")
        return { session: { ...session(params.sessionId), title: params.title } };
      if (method === "run.cancel") return { runId: params.runId, status: "cancelled" };
      if (method === "rewind.list")
        return {
          checkpoints: [
            {
              checkpointId: "cp1",
              label: "原始任务",
              createdAt: 1,
              changedFileCount: 1,
              additions: 3,
              deletions: 2,
            },
          ],
        };
      if (method === "provider.list") return { providers: [], revision: "r1" };
      if (method === "provider.importEnvironment") return { provider: { id: "fixture" } };
      throw new Error(`Unexpected RPC ${method}`);
    },
  };
  let handler: (event: unknown, value: unknown) => Promise<unknown>;
  let trusted = true;
  let quitting = false;
  const dispose = registerCommandIpc({
    ipcMain: {
      handle(channel, listener) {
        assert.equal(channel, DESKTOP_COMMAND_CHANNEL);
        handler = listener as typeof handler;
      },
      removeHandler(channel) {
        assert.equal(channel, DESKTOP_COMMAND_CHANNEL);
      },
    },
    runtime: runtime as never,
    trusted: () => trusted,
    isQuitting: () => quitting,
  });
  const ipc = {
    invoke: async (_channel: string, value: unknown) => handler({ sender: { id: 1 } }, value),
  };
  const bridge = createCommandBridge(ipc);
  const context = { workspacePath: "/fixture", sessionId: "s1" };
  const catalog = await bridge.catalog(context);
  assert.ok(catalog.ok);
  const tui = createClientCommandRegistry({ runtime: {} as never, workspacePath: "/fixture" });
  assert.deepEqual(
    Object.keys(DESKTOP_COMMAND_POLICY).sort(),
    tui
      .list()
      .map((item) => item.name)
      .sort(),
  );
  assert.equal(catalog.value.length, 27);
  assert.equal(catalog.value.filter((item) => item.tier === "primary").length, 12);
  assert.equal(catalog.value.filter((item) => item.tier === "advanced").length, 15);
  const countBeforeUnsupported = calls.length;
  for (const command of tui.list()) {
    const policy = desktopCommandPolicy(command.name)!;
    if (policy.tier === "primary" || policy.tier === "advanced") continue;
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const rejected = await bridge.execute(context, `/${name} delete --confirm`, randomUUID());
      assert.ok(rejected.ok);
      assert.equal(rejected.value.outcome.kind, "rejected");
      assert.equal(Boolean(rejected.value.redirect), policy.tier === "page");
      const completion = await bridge.complete(context, `/${name} `);
      assert.ok(completion.ok);
      assert.deepEqual(completion.value, []);
    }
  }
  assert.equal(calls.length, countBeforeUnsupported, "C/D 输入、别名及补全不得触发任何 RPC");
  const execute = async (text: string, target = context, id = randomUUID()) => {
    const result = await bridge.execute(target, text, id);
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  assert.equal((await execute("/help cron")).redirect?.destination, "automations");
  assert.equal((await execute("/help")).outcome.result?.message?.includes("/plugin"), false);
  assert.deepEqual((await execute("/goal")).action, { kind: "open", target: "goal" });
  const fresh = await execute("/new");
  assert.equal(fresh.switchSession, null);
  assert.equal(fresh.outcome.result?.message?.includes("失败"), undefined);
  const id = randomUUID();
  await Promise.all([execute("/goal pause", context, id), execute("/goal pause", context, id)]);
  assert.equal(calls.filter((call) => call.method === "goal.get").length, 1);
  assert.equal(calls.filter((call) => call.method === "goal.control").length, 0);
  const goalIntent = (await execute("/goal pause")).action;
  assert.deepEqual(goalIntent, {
    kind: "goal",
    input: { action: "pause", goalId: "g1", expectedRevision: 1 },
  });
  assert.equal((await execute("/resume s2")).switchSession, "s2");
  assert.deepEqual((await execute("/fork s2")).action, { kind: "fork", sessionId: "s2" });
  assert.deepEqual((await execute("/compact")).action, { kind: "compact" });
  assert.equal(
    calls.some((call) => call.method === "session.compact" || call.method === "session.fork"),
    false,
    "确认和执行由已有桌面动作负责",
  );
  assert.equal((await execute("/resume")).outcome.result?.ui?.kind, "open-selector");
  assert.equal((await execute("/new")).switchSession, null);
  const complete = await bridge.complete(context, "/resume s2");
  assert.ok(complete.ok);
  assert.equal(complete.value[0]?.value, "s2");
  assert.equal((await execute("/not-a-command")).outcome.kind, "unknown");
  assert.equal((await execute("/cls")).outcome.kind, "rejected");
  assert.equal((await execute("/quit")).outcome.kind, "rejected");
  assert.equal(
    calls.some((call) =>
      ["session.send", "session.create", "session.delete"].includes(call.method),
    ),
    false,
  );
  const rewind = await execute("/rewind cp1");
  assert.equal(
    (rewind.outcome.result?.data as { selectedMessageId: string }).selectedMessageId,
    "cp1",
  );
  const changes = await execute("/changes cp1");
  assert.equal((changes.outcome.result?.data as { checkpointId: string }).checkpointId, "cp1");
  active = true;
  assert.equal((await execute("/rename blocked")).outcome.kind, "rejected");
  assert.equal(
    calls.some((call) => call.method === "session.rename"),
    false,
  );
  assert.match((await execute("/swarm status")).outcome.result?.message ?? "", /Swarm/);
  await execute("/steer 调整方向");
  const sent = calls.find((call) => call.method === "session.send")!;
  assert.deepEqual(sent.params.input, { kind: "text", text: "调整方向" });
  assert.equal(sent.params.behavior, "steer");
  assert.equal(sent.params.expectedRunId, "run-1");
  await execute("/interrupt");
  assert.equal(calls.at(-1)?.method, "run.cancel");
  const preSession = await bridge.execute(
    { workspacePath: "/fixture", initialSettings: { modelRouteId: "p/m" } },
    "/mode plan",
    randomUUID(),
  );
  assert.ok(preSession.ok);
  assert.equal(preSession.value.initialSettings?.collaborationMode, "plan");

  active = false;
  loseSendResponse = true;
  const retryId = randomUUID();
  const acceptedBefore = admissions.size;
  assert.match(
    (await execute("/swarm 执行任务", context, retryId)).outcome.result?.message ?? "",
    /响应丢失/,
  );
  // Admission already started a run; retry must use the original request even though
  // a new /swarm task would now be unavailable.
  assert.equal((await execute("/swarm 执行任务", context, retryId)).outcome.kind, "sent");
  assert.equal(admissions.size, acceptedBefore + 1);
  const retriedSends = calls.filter(
    (call) => call.method === "session.send" && call.params.idempotencyKey === retryId,
  );
  assert.equal(retriedSends.length, 2);
  assert.deepEqual(retriedSends[0]?.params, retriedSends[1]?.params);

  // Provider/automation credentials are no longer accessible through Desktop commands.
  active = false;
  const names = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_API_KEYS"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      LLM_BASE_URL: "https://fixture.invalid",
      LLM_MODEL: "m",
      LLM_API_KEY: "private-fixture-secret",
      LLM_API_KEYS: "",
    });
    assert.doesNotMatch(
      JSON.stringify(await execute("/provider import-env fixture")),
      /private-fixture-secret/,
    );
    assert.equal(
      calls.some((call) => call.method === "provider.importEnvironment"),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(await execute("/provider import-env fixture --confirm")),
      /private-fixture-secret/,
    );
    assert.equal(
      calls.some((call) => call.method === "provider.importEnvironment"),
      false,
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
  const unboundBefore = calls.length;
  const unbound = { workspacePath: "" };
  const contextResult = await bridge.execute(unbound, "/context", randomUUID());
  assert.ok(contextResult.ok);
  assert.equal(contextResult.value.outcome.kind, "rejected");
  const history = await bridge.execute(unbound, "/resume", randomUUID());
  assert.ok(history.ok);
  assert.deepEqual(history.value.action, { kind: "open", target: "sessions" });
  const picker = await bridge.execute(unbound, "/model", randomUUID());
  assert.ok(picker.ok);
  assert.deepEqual(picker.value.action, { kind: "open", target: "model" });
  assert.equal(calls.length, unboundBefore, "只读或选择操作不能创建临时项目/空会话");
  const count = calls.length;
  trusted = false;
  assert.equal((await bridge.execute(context, "/goal pause", randomUUID())).ok, false);
  trusted = true;
  quitting = true;
  assert.equal((await bridge.execute(context, "/goal pause", randomUUID())).ok, false);
  quitting = false;
  assert.equal((await bridge.execute(context, "普通消息", randomUUID())).ok, false);
  assert.equal((await bridge.catalog({ workspacePath: "relative-path" })).ok, false);
  assert.equal(calls.length, count);
  dispose();
});
