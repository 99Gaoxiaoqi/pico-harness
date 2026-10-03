import assert from "node:assert/strict";
import test from "node:test";
import { RemoteProtocolError, type RemoteParams } from "@pico/protocol/remote";
import {
  DraftRepository,
  draftKey,
  draftInput,
  draftSendReason,
  emptyDraft,
  submitDraft,
  type ComposerDraft,
  type DraftScope,
  type DraftStorage,
} from "../../../apps/mobile/src/conversation/draft.js";

const scope: DraftScope = { hostId: "computer-a", workspaceId: "workspace", sessionId: "session" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Storage implements DraftStorage {
  readonly values = new Map<string, string>();
  gate?: { key: string; promise: Promise<void> };
  fail = false;
  readonly active = new Map<string, number>();
  readonly maximum = new Map<string, number>();
  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    const active = (this.active.get(key) ?? 0) + 1;
    this.active.set(key, active);
    this.maximum.set(key, Math.max(this.maximum.get(key) ?? 0, active));
    try {
      if (this.gate?.key === key) await this.gate.promise;
      if (this.fail) throw new Error("storage unavailable");
      this.values.set(key, value);
    } finally {
      this.active.set(key, active - 1);
    }
  }
  async removeItem(key: string) {
    this.values.delete(key);
  }
}
function request(draft: ComposerDraft): RemoteParams<"session.send"> {
  return {
    sessionId: scope.sessionId,
    input: draftInput(draft),
    behavior: draft.mode,
    idempotencyKey: draft.idempotencyKey,
    expectedRunId: "running",
  };
}

test("手机完整草稿串行落盘、跨电脑隔离，未知发送重启后沿用原请求并明确成功清除", async () => {
  const storage = new Storage();
  const repository = new DraftRepository(storage);
  const gate = deferred();
  storage.gate = { key: draftKey(scope), promise: gate.promise };
  const draft: ComposerDraft = {
    ...emptyDraft("input-key"),
    text: "总结这些内容",
    images: [{ type: "image_base64", mimeType: "image/jpeg", data: "YQ==" }],
    skills: [{ name: "summarize", sourceId: "project-resource" }],
    mode: "queue",
  };
  const first = repository.save(scope, draft);
  draft.text = "最后一次输入";
  const last = repository.save(scope, draft);
  const restored = repository.load(scope);
  const anotherScope = { ...scope, hostId: "computer-b" };
  await repository.save(anotherScope, {
    ...emptyDraft("agent-key"),
    text: "审阅实现",
    agent: { name: "reviewer", subagentId: "configured-reviewer" },
  });
  assert.equal(storage.values.has(draftKey(scope)), false, "慢写不阻塞其他电脑的草稿");
  gate.resolve();
  await first;
  await last;
  assert.equal((await restored)?.text, "最后一次输入", "卸载前最后一笔写入仍排队完成");
  assert.equal(storage.maximum.get(draftKey(scope)), 1, "同键禁止并行写入");
  assert.notEqual(
    draftKey({ ...scope, hostId: "a/b", workspaceId: "c" }),
    draftKey({ ...scope, hostId: "a", workspaceId: "b/c" }),
    "scope编码无路径拼接碰撞",
  );
  assert.match(draftSendReason({ ...draft, mode: "steer" }, true)!, /排队或替换/);
  assert.equal(draftSendReason(draft, true), undefined);
  const admitted = request(draft);
  let sends = 0;
  await assert.rejects(
    submitDraft(repository, scope, draft, admitted, async (sent) => {
      sends++;
      const durable = JSON.parse(storage.values.get(draftKey(scope))!);
      assert.deepEqual(durable.draft.pending, sent, "RPC之前完整请求和幂等键已落盘");
      throw new RemoteProtocolError("DISCONNECTED", "响应丢失", true, "unknown");
    }),
    /响应丢失/,
  );
  const restarted = new DraftRepository(storage);
  const frozen = (await restarted.load(scope))!;
  assert.deepEqual(frozen.pending, admitted);
  assert.deepEqual(frozen.images, draft.images);
  assert.deepEqual(frozen.skills, draft.skills);
  assert.equal(frozen.mode, "queue");
  await submitDraft(restarted, scope, frozen, frozen.pending!, async (retry) => {
    sends++;
    assert.deepEqual(retry, admitted, "重启后的重试不改变Run身份、输入或幂等键");
    return { accepted: true };
  });
  assert.equal(sends, 2);
  assert.equal(await restarted.load(scope), undefined, "明确成功后删除整份草稿");
  const other = (await restarted.load(anotherScope))!;
  assert.match(draftSendReason({ ...other, text: "" }, false)!, /Agent 任务/);
  assert.deepEqual(other.agent, { name: "reviewer", subagentId: "configured-reviewer" });
  assert.deepEqual(draftInput(other), {
    kind: "agent",
    name: "reviewer",
    subagentId: "configured-reviewer",
    task: "审阅实现",
  });
});

test("手机落盘失败阻止RPC，确定未执行解冻，迟到成功不删除新草稿，损坏版本须明确清除", async () => {
  const storage = new Storage();
  const repository = new DraftRepository(storage);
  const draft = { ...emptyDraft("original"), text: "旧内容" };
  storage.fail = true;
  let called = false;
  await assert.rejects(
    submitDraft(repository, scope, draft, request(draft), async () => {
      called = true;
    }),
    /storage unavailable/,
  );
  assert.equal(called, false);
  storage.fail = false;
  await assert.rejects(
    submitDraft(repository, scope, draft, request(draft), async () => {
      throw new RemoteProtocolError("CONFLICT", "未执行", false, "not_executed");
    }),
    /未执行/,
  );
  assert.equal((await repository.load(scope))?.pending, undefined);
  const response = deferred();
  const started = deferred();
  const late = submitDraft(repository, scope, draft, request(draft), async () => {
    started.resolve();
    await response.promise;
    return "accepted";
  });
  await started.promise;
  await repository.clear(scope);
  const fresh = { ...emptyDraft("new-input"), text: "已确认后新建的草稿" };
  await repository.save(scope, fresh);
  response.resolve();
  await late;
  assert.equal((await repository.load(scope))?.text, fresh.text);
  await assert.rejects(
    repository.save(scope, {
      ...fresh,
      skills: Array.from({ length: 17 }, (_, i) => ({ name: `skill-${i}` })),
    }),
    /16/,
  );
  await assert.rejects(
    repository.save(scope, { ...fresh, agent: { name: "one" }, skills: [{ name: "two" }] }),
    /只能选择一个 Agent/,
  );
  storage.values.set(draftKey(scope), JSON.stringify({ version: 2, draft: fresh }));
  await assert.rejects(repository.load(scope), /版本不兼容/);
  assert.ok(storage.values.has(draftKey(scope)), "读取错误不能静默删除原数据");
  await repository.clear(scope);
  assert.equal(await repository.load(scope), undefined);
});

test("同会话共享发送锁，unknown 的拒绝重试保留原逻辑请求和权威状态", async () => {
  const storage = new Storage();
  const repository = new DraftRepository(storage);
  const draft: ComposerDraft = {
    ...emptyDraft("unknown-input"),
    text: "原输入",
    mode: "replace",
    skills: [{ name: "summarize", sourceId: "project-resource" }],
    images: [{ type: "image_base64", mimeType: "image/jpeg", data: "YQ==" }],
  };
  const original = request(draft);
  await repository.save(scope, draft);
  const started = deferred();
  const response = deferred();
  const first = submitDraft(repository, scope, draft, original, async () => {
    started.resolve();
    await response.promise;
    throw new RemoteProtocolError("DISCONNECTED", "原请求响应未知", true, "unknown");
  });
  await started.promise;
  let duplicateCalls = 0;
  await assert.rejects(
    submitDraft(repository, scope, draft, original, async () => {
      duplicateCalls++;
    }),
    /正在发送/,
  );
  assert.equal(duplicateCalls, 0, "重挂载也不能并行发出第二个同scope请求");
  assert.equal(repository.isSending(scope), true);
  response.resolve();
  await assert.rejects(first, /原请求响应未知/);
  const frozen = (await repository.load(scope))!;
  await assert.rejects(
    submitDraft(
      repository,
      scope,
      frozen,
      {
        ...original,
        input: { kind: "text", text: "当前界面生成的新输入" },
        behavior: "auto",
        expectedRunId: "new-running",
        idempotencyKey: "new-key",
      },
      async (retry) => {
        assert.deepEqual(retry, original, "重试沿用输入、行为、Run和幂等键");
        throw new RemoteProtocolError("UNAUTHORIZED", "仅该重试未执行", false, "not_executed");
      },
    ),
    /仅该重试未执行/,
  );
  assert.deepEqual(
    (await repository.load(scope))?.pending,
    original,
    "拒绝重试不能证明原unknown请求未执行",
  );
  let notified = false;
  const unsubscribe = repository.subscribe(scope, (state) => {
    if (state.ready && !state.draft) notified = true;
  });
  await submitDraft(repository, scope, frozen, frozen.pending!, async () => "accepted");
  assert.equal(notified, true, "明确成功向后来挂载的订阅者发布清除状态");
  assert.equal(repository.isSending(scope), false);
  unsubscribe();
});

test("清除产生新草稿代次，旧attempt迟到失败不剥离新pending也不释放新锁", async () => {
  const repository = new DraftRepository(new Storage());
  const oldDraft = { ...emptyDraft("old-key"), text: "旧消息" };
  const oldStarted = deferred();
  const oldResponse = deferred();
  const oldAttempt = submitDraft(repository, scope, oldDraft, request(oldDraft), async () => {
    oldStarted.resolve();
    await oldResponse.promise;
    throw new RemoteProtocolError("DISCONNECTED", "旧尝试未执行", true, "not_executed");
  });
  await oldStarted.promise;
  await repository.clear(scope);
  const fresh = { ...emptyDraft("new-key"), text: "新消息" };
  await repository.save(scope, fresh);
  const newStarted = deferred();
  const newResponse = deferred();
  const newAttempt = submitDraft(repository, scope, fresh, request(fresh), async () => {
    newStarted.resolve();
    await newResponse.promise;
    return "accepted";
  });
  await newStarted.promise;
  oldResponse.resolve();
  await assert.rejects(oldAttempt, /旧尝试未执行/);
  assert.deepEqual((await repository.load(scope))?.pending, request(fresh));
  assert.equal(repository.isSending(scope), true);
  newResponse.resolve();
  await newAttempt;
  assert.equal(await repository.load(scope), undefined);
  assert.equal(repository.isSending(scope), false);
});
