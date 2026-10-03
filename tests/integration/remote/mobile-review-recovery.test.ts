import assert from "node:assert/strict";
import test from "node:test";
import { RemoteProtocolError } from "@pico/protocol/remote";
import type { RuntimePort } from "../../../apps/mobile/src/core.js";
import { MobileReview } from "../../../apps/mobile/src/review-controller.js";
import {
  ReviewRequestStorage,
  type ReviewStoragePort,
} from "../../../apps/mobile/src/review-request-storage.js";

test("手机审阅先落盘，未知操作重开后要求 Host 幂等能力并保留原键，新意图使用新键", async () => {
  const values = new Map<string, string>();
  let storageFails = false;
  const storage: ReviewStoragePort = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (storageFails) throw new Error("storage unavailable");
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  let ids = 0;
  let supportsIdempotency = false;
  const repository = () =>
    new ReviewRequestStorage(storage, "host/workspace/session", () => `operation-${++ids}`);
  const requests: Record<string, unknown>[] = [];
  const port = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "runs.list")
        return {
          runs: [{ runId: "run", sessionId: "session", status: "succeeded", startedAt: 1 }],
        };
      if (method === "changes.list") return { changes: [], fingerprint: "fingerprint" };
      assert.equal(method, "changes.review");
      assert.deepEqual(
        await repository().load(),
        params,
        "original request is durable before dispatch",
      );
      requests.push(params);
      if (requests.length === 1)
        throw new RemoteProtocolError("DISCONNECTED", "reply lost", true, "unknown");
      return { accepted: true, fingerprint: "fingerprint" };
    },
  } as unknown as RuntimePort;
  const mount = () =>
    new MobileReview(port, "workspace", "session", undefined, {
      recoveryStorage: repository(),
      canRetry: () => supportsIdempotency,
    });
  const first = mount();
  await first.refresh();
  storageFails = true;
  assert.equal(await first.submit("request_changes", "评论"), false);
  assert.equal(requests.length, 0, "storage failure blocks the RPC");
  storageFails = false;
  await first.refresh(true);
  assert.equal(await first.submit("request_changes", "  原评论  "), false);
  first.suspend();
  const reopened = mount();
  await reopened.refresh(true);
  assert.equal(reopened.state.unknown, true);
  assert.equal(reopened.state.recovery?.message, "原评论");
  assert.equal(await reopened.retryUnknown(), false);
  assert.equal(requests.length, 1, "a Host without idempotency cannot receive unsafe retries");
  supportsIdempotency = true;
  assert.equal(await reopened.retryUnknown(), true);
  assert.deepEqual(requests[0], requests[1]);
  await reopened.refresh(true);
  assert.equal(await reopened.submit("approve"), true);
  assert.notEqual(requests[2]?.idempotencyKey, requests[1]?.idempotencyKey);
  assert.equal(await repository().load(), undefined);
});

test("手机旧页面迟到的审阅确认不删除重开页面持有的恢复请求", async () => {
  const values = new Map<string, string>();
  const storage: ReviewStoragePort = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const port = {
    request: async (method: string) => {
      if (method === "runs.list")
        return {
          runs: [{ runId: "run", sessionId: "session", status: "succeeded", startedAt: 1 }],
        };
      if (method === "changes.list") return { changes: [], fingerprint: "fingerprint" };
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return { accepted: true, fingerprint: "fingerprint" };
    },
  } as unknown as RuntimePort;
  const repository = () => new ReviewRequestStorage(storage, "late-review", () => "original-key");
  const mount = () =>
    new MobileReview(port, "workspace", "session", undefined, {
      recoveryStorage: repository(),
      canRetry: () => true,
    });
  const old = mount();
  await old.refresh();
  const sending = old.submit("request_changes", "原评论");
  await entered.promise;
  old.suspend();
  const reopened = mount();
  await reopened.refresh(true);
  release.resolve();
  assert.equal(await sending, false);
  assert.equal((await repository().load())?.idempotencyKey, "original-key");
  assert.equal(reopened.state.unknown, true);
  assert.equal(await reopened.retryUnknown(), true);
  assert.equal(await repository().load(), undefined);
});

test("手机同一面板重开先等待旧请求落盘，不创建新键也不被旧写入覆盖", async () => {
  const values = new Map<string, string>();
  const saveEntered = Promise.withResolvers<void>();
  const releaseSave = Promise.withResolvers<void>();
  let saves = 0;
  const storage: ReviewStoragePort = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      if (++saves === 1) {
        saveEntered.resolve();
        await releaseSave.promise;
      }
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  const requests: Record<string, unknown>[] = [];
  const port = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "runs.list")
        return {
          runs: [{ runId: "run", sessionId: "session", status: "succeeded", startedAt: 1 }],
        };
      if (method === "changes.list") return { changes: [], fingerprint: "fingerprint" };
      requests.push(params);
      return { accepted: true, fingerprint: "fingerprint" };
    },
  } as unknown as RuntimePort;
  let ids = 0;
  const repository = () => new ReviewRequestStorage(storage, "pending-save", () => `key-${++ids}`);
  const mount = () =>
    new MobileReview(port, "workspace", "session", undefined, {
      recoveryStorage: repository(),
      canRetry: () => true,
    });
  const old = mount();
  await old.refresh();
  const sending = old.submit("request_changes", "原评论");
  await saveEntered.promise;
  old.suspend();
  const reopened = mount();
  let restored = false;
  const refreshing = reopened.refresh(true).then(() => {
    restored = true;
  });
  const newIntent = reopened.submit("request_changes", "不能覆盖原评论");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(restored, false, "restoration waits for the previous panel's native storage write");
  releaseSave.resolve();
  assert.equal(await sending, false);
  await refreshing;
  assert.equal(await newIntent, false);
  assert.equal(reopened.state.unknown, true);
  assert.equal(reopened.state.recovery?.message, "原评论");
  assert.equal(reopened.state.recovery?.idempotencyKey, "key-1");
  assert.equal(ids, 1);
  assert.equal(requests.length, 0, "suspended panel cannot dispatch after its late storage write");
  assert.equal(await reopened.retryUnknown(), true);
  assert.equal(requests[0]?.idempotencyKey, "key-1");
});
