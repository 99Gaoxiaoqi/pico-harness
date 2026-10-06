import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRuntimeResult,
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  RuntimeAccessSession,
  GatewayError,
  type GatewayRuntimeClient,
  type RuntimeAccessEventSink,
} from "../../../packages/remote-gateway/src/index.js";

const session = {
  sessionId: "session-1",
  workspacePath: "/registered/project",
  title: "接入会话",
  status: "active",
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RuntimeFixture implements GatewayRuntimeClient {
  readonly calls: Array<{ method: RuntimeMethod; params: unknown }> = [];
  frames?: (frame: RuntimeSessionSubscriptionFrame) => void;
  holdOpen?: ReturnType<typeof deferred>;
  readonly enteredOpen = deferred();
  holdSubscribe?: ReturnType<typeof deferred>;
  readonly enteredSubscribe = deferred();
  disposed = 0;
  closed = false;
  async request<M extends RuntimeMethod>(
    method: M,
    params: RuntimeParams<M>,
  ): Promise<RuntimeResult<M>> {
    this.calls.push({ method, params });
    let result: unknown;
    if (method === "session.get") result = { session };
    else if (method === "session.send") result = { session, disposition: "started" };
    else if (method === "session.subscription.close") result = { closed: true };
    else if (method === "session.subscription.open") {
      this.frames?.({
        hostEpoch: "host",
        subscriptionId: "session-sub",
        sessionId: session.sessionId,
        sequence: 1,
        type: "subscription.resource_changed",
        resource: "tasks",
        revision: 2,
      });
      this.enteredOpen.resolve();
      await this.holdOpen?.promise;
      result = {
        session,
        hostEpoch: "host",
        subscriptionId: "session-sub",
        nextSequence: 1,
        watermark: {
          historyEpoch: "history",
          projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
          throughSequence: 0,
        },
        durableTail: [],
        activeOverlay: [],
        queuedInputs: [],
      };
    } else throw new Error(`Unexpected Runtime method: ${method}`);
    return parseRuntimeResult(method, result);
  }
  async subscribe(): ReturnType<GatewayRuntimeClient["subscribe"]> {
    this.enteredSubscribe.resolve();
    await this.holdSubscribe?.promise;
    return {
      replay: { subscribed: true, events: [], hasMore: false },
      dispose: () => {
        this.disposed++;
      },
    };
  }
  subscribeSessionFrames(listener: (frame: RuntimeSessionSubscriptionFrame) => void) {
    this.frames = listener;
    return {
      dispose: () => {
        if (this.frames === listener) this.frames = undefined;
      },
    };
  }
  close() {
    this.closed = true;
  }
}

function fixture() {
  const runtime = new RuntimeFixture();
  let current = true;
  const access = new RuntimeAccessSession({
    config: { workspaces: [{ id: "project", name: "项目", path: session.workspacePath }] },
    // This is a trusted in-process channel adapter, with no mobile token, TLS or HTTP request.
    principal: {
      id: "channel:example:account:user",
      terminalOwnerId: "channel:example:account:user",
      permissions: ["workspace.read", "session.control"],
      workspaceIds: ["project"],
    },
    client: runtime,
    isCurrent: () => current,
  });
  const messages: Array<Parameters<RuntimeAccessEventSink["publish"]>[0] | { type: "reply" }> = [];
  const events = access.attachEvents({ publish: (event) => messages.push(event), close() {} });
  const request = (method: string, params: object, workspaceId = "project") => ({
    version: 1,
    requestId: "request-1",
    method,
    params,
    workspaceId,
  });
  return {
    access,
    runtime,
    messages,
    events,
    request,
    revoke: () => {
      current = false;
    },
  };
}

test("非 HTTP 接入复用手机授权、会话请求与事件协议，订阅答复先于提前到达的帧", async () => {
  const f = fixture();
  try {
    await f.access.dispatch(
      f.request("session.send", {
        sessionId: session.sessionId,
        input: { kind: "text", text: "读取项目" },
        idempotencyKey: "channel-message-1",
      }),
      (value) => {
        assert.equal((value as { disposition: string }).disposition, "started");
      },
    );
    const sent = f.runtime.calls.find((call) => call.method === "session.send")!;
    assert.equal((sent.params as Record<string, unknown>).workspacePath, session.workspacePath);
    assert.equal((sent.params as Record<string, unknown>).idempotencyKey, "channel-message-1");
    await f.access.dispatch(
      f.request("session.subscription.open", { sessionId: session.sessionId }),
      () => {
        f.messages.push({ type: "reply" });
      },
    );
    assert.deepEqual(
      f.messages.map((event) => event.type),
      ["reply", "session_frame"],
    );
    const before = f.runtime.calls.length;
    await assert.rejects(
      f.access.dispatch(
        f.request("session.get", { sessionId: session.sessionId }, "other"),
        () => {},
      ),
      (error: unknown) => error instanceof GatewayError && error.code === "FORBIDDEN",
    );
    await assert.rejects(
      f.access.dispatch(f.request("config.get", {}), () => {}),
      (error: unknown) => error instanceof GatewayError && error.code === "FORBIDDEN",
    );
    assert.equal(f.runtime.calls.length, before, "unauthorized operations never reach Runtime");
    f.events.close();
    assert.equal(
      f.runtime.closed,
      false,
      "transport disconnection does not stop Runtime client/tasks",
    );
    assert.equal(
      f.runtime.calls.some((call) => call.method === "run.cancel"),
      false,
    );
  } finally {
    f.access.close();
  }
});

test("接入授权或事件连接失效后，迟到的订阅结果必须清理且不能恢复旧帧", async () => {
  for (const invalidation of ["grant", "events"] as const) {
    const f = fixture();
    f.runtime.holdOpen = deferred();
    try {
      const pending = f.access.dispatch(
        f.request("session.subscription.open", { sessionId: session.sessionId }),
        () => {
          assert.fail("an invalidated open must not publish success");
        },
      );
      const rejected = assert.rejects(
        pending,
        (error: unknown) => error instanceof GatewayError && error.outcome === "unknown",
      );
      await f.runtime.enteredOpen.promise;
      if (invalidation === "grant") f.revoke();
      else f.events.close();
      f.runtime.holdOpen.resolve();
      await rejected;
      assert.deepEqual(f.messages, []);
      assert.equal(
        f.runtime.calls.filter((call) => call.method === "session.subscription.close").length,
        1,
      );
    } finally {
      f.access.close();
    }
  }
  const f = fixture();
  f.runtime.holdSubscribe = deferred();
  try {
    const pending = f.events.receive({
      type: "subscribe",
      subscriptionId: "events",
      workspaceId: "project",
    });
    await f.runtime.enteredSubscribe.promise;
    f.revoke();
    f.runtime.holdSubscribe.resolve();
    await pending;
    assert.equal(f.runtime.disposed, 1);
    assert.deepEqual(f.messages, []);
  } finally {
    f.access.close();
  }
});
