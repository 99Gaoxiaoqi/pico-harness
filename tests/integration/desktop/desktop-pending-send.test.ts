import assert from "node:assert/strict";
import test from "node:test";
import {
  PendingSendRepository,
  PENDING_SEND_PREFIX,
} from "../../../apps/desktop/src/renderer/pending-send.js";
import type { RuntimeParams, RuntimeResult } from "@pico/protocol";

class TestStorage {
  readonly data = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.data.size;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw Error("storage blocked");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}
const scope = { picoHome: "/state/a", sourceKey: "new:unbound" };
const params: RuntimeParams<"session.send"> = {
  workspacePath: "/state/temporary-original",
  input: {
    kind: "text",
    text: "执行任务",
    skills: [{ name: "review", sourceId: "user:review", sourcePath: "/skills/review" }],
  },
  initialSettings: {
    modelRouteId: "test/original",
    collaborationMode: "agent",
    orchestrationMode: "default",
    permissionMode: "auto",
    thinkingEffort: "high",
  },
  behavior: "replace",
  expectedRunId: "original-run",
  idempotencyKey: "original-key",
};
const receipt = { session: { sessionId: "original-session" } } as RuntimeResult<"session.send">;

test("Desktop pending sends survive repository reconstruction and replay only the frozen request", async () => {
  const storage = new TestStorage();
  const first = new PendingSendRepository(storage);
  let calls = 0;
  await assert.rejects(
    first.send(scope, params, "raw /skill review draft", async (request) => {
      calls++;
      assert.deepEqual(request, params);
      throw Error("response lost");
    }),
  );
  assert.equal(calls, 1);
  const reconstructed = new PendingSendRepository(storage);
  assert.equal(reconstructed.list("/state/a").length, 1);
  assert.equal(reconstructed.list("/state/b").length, 0);
  await assert.rejects(
    reconstructed.send(scope, { ...params, idempotencyKey: "new-key" }, "new draft", async () => {
      calls++;
      return receipt;
    }),
  );
  await assert.rejects(
    reconstructed.recover(scope, false, async () => {
      calls++;
      return receipt;
    }),
    /更新 Pico/u,
  );
  assert.equal(calls, 1, "pending/new input and missing capability must not send");
  const recovered = await reconstructed.recover(scope, true, async (request) => {
    calls++;
    assert.deepEqual(request, { ...params, replayOnly: true });
    return receipt;
  });
  assert.equal(recovered.confirmed, true);
  assert.equal(recovered.record.draftSnapshot, "raw /skill review draft");
  assert.equal(reconstructed.get(scope), undefined);
});

test("Desktop pending sends fail closed for storage, corrupt records, and subsequent recovery rejections", async () => {
  const storage = new TestStorage();
  const repository = new PendingSendRepository(storage);
  let calls = 0;
  const send = async () => {
    calls++;
    return receipt;
  };
  storage.failWrites = true;
  await assert.rejects(repository.send(scope, params, "draft", send), /storage blocked/u);
  assert.equal(calls, 0);
  storage.failWrites = false;
  await assert.rejects(
    repository.send(scope, params, "draft", async () => {
      throw Object.assign(Error("lost"), { outcome: "unknown" });
    }),
  );
  await assert.rejects(
    repository.recover(scope, true, async () => {
      throw Object.assign(Error("denied later"), { outcome: "not_executed" });
    }),
  );
  assert.equal(repository.get(scope)?.kind, "pending");
  await assert.rejects(
    repository.recover(scope, true, async () => {
      throw Object.assign(Error("no receipt"), { code: "SEND_RECOVERY_UNAVAILABLE" });
    }),
  );
  assert.equal(repository.get(scope)?.kind, "pending");
  repository.abandon(scope);
  await assert.rejects(
    repository.send(scope, params, "draft", async () => {
      throw Object.assign(Error("preflight denied"), { outcome: "not_executed" });
    }),
  );
  assert.equal(repository.get(scope), undefined);
  const key = PENDING_SEND_PREFIX + JSON.stringify([scope.picoHome, scope.sourceKey]);
  for (const raw of [
    "broken json",
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      scope,
      generation: "g",
      draftSnapshot: "draft",
      params: { ...params, unknown: true },
    }),
  ]) {
    storage.setItem(key, raw);
    assert.equal(repository.get(scope)?.kind, "blocked");
    await assert.rejects(repository.recover(scope, true, send));
    assert.equal(storage.getItem(key), raw);
  }
  assert.equal(calls, 0);
});

test("Desktop pending scopes and generation guards isolate three entry points and late callbacks", async () => {
  const storage = new TestStorage();
  const repository = new PendingSendRepository(storage);
  const scopes = [
    scope,
    { ...scope, sourceKey: 'side:["/project","parent","panel"]' },
    { ...scope, sourceKey: 'research-implement:["/project","research"]' },
    { ...scope, picoHome: "/state/b" },
  ];
  for (const item of scopes)
    await assert.rejects(
      repository.send(item, params, item.sourceKey, async () => {
        throw Error("lost");
      }),
    );
  assert.equal(repository.list(scope.picoHome).length, 3);
  assert.equal(repository.list("/state/b").length, 1);
  let finish!: (value: RuntimeResult<"session.send">) => void;
  const late = repository.recover(
    scope,
    true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await assert.rejects(
    repository.recover(scope, true, async () => receipt),
    /正在确认/u,
  );
  repository.abandon(scope);
  const newRenderer = new PendingSendRepository(storage);
  await assert.rejects(
    newRenderer.send(
      scope,
      { ...params, idempotencyKey: "replacement-key" },
      "replacement draft",
      async () => {
        throw Error("lost replacement");
      },
    ),
  );
  finish(receipt);
  assert.equal((await late).confirmed, false);
  const replacement = repository.get(scope);
  assert.equal(
    replacement?.kind === "pending" && replacement.record.params.idempotencyKey,
    "replacement-key",
  );
  assert.equal(repository.list(scope.picoHome).length, 3);
});
