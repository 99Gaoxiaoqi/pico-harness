import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  isRuntimeTerminalFrame,
  parseRuntimeResult,
  TERMINAL_STREAM_RUNTIME_CAPABILITY,
  type RuntimeMethod,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeTerminalFrame,
} from "@pico/protocol";
import { DesktopWorkbarTerminalService } from "../../../packages/pico-host/src/desktop-workbar-terminal-service.js";
import {
  GatewayError,
  RuntimeAccessSession,
  type GatewayRuntimeClient,
  type RuntimeAccessEventSink,
} from "../../../packages/remote-gateway/src/index.js";

test("真实 Shell 输出按连接附着推送，旁观者只读，detach 保留进程", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-terminal-stream-"));
  const workspacePath = await realpath(directory);
  const service = new DesktopWorkbarTerminalService({ picoHome: directory });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const framesA: RuntimeTerminalFrame[] = [];
  const framesB: RuntimeTerminalFrame[] = [];
  const context = (id: string, frames: RuntimeTerminalFrame[]) => ({
    terminalOwnerId: id,
    terminalAttachmentId: id,
    surface: "tui" as const,
    pushTerminalFrame: async (frame: RuntimeTerminalFrame) => {
      assert.ok(isRuntimeTerminalFrame(frame));
      frames.push(frame);
    },
  });
  const a = context("owner-a", framesA),
    b = context("owner-b", framesB);
  const created = await service.create({ workspacePath, sessionId: "session-stream" }, a);
  const scope = {
    workspacePath,
    sessionId: "session-stream",
    terminalId: created.terminal.terminalId,
  };
  const attached = await service.attach(scope, b);
  assert.equal(attached.terminal.controlAllowed, false);
  const framesSame: RuntimeTerminalFrame[] = [];
  const sameOwnerView = {
    ...context("owner-a", framesSame),
    terminalAttachmentId: "owner-a:view2",
    terminalStreamId: "view2",
  };
  await service.attach(scope, sameOwnerView);
  const input = {
    ...scope,
    resourceEpoch: created.resourceEpoch,
    data: "printf 'HOST_STREAM_OK\\n'\r",
  };
  await assert.rejects(service.input(input, b));
  await service.input(input, a);
  for (
    let n = 0;
    n < 100 && !framesB.some((f) => f.kind === "output" && f.data.includes("HOST_STREAM_OK"));
    n++
  )
    await delay(20);
  assert.ok(framesA.some((f) => f.kind === "output" && f.data.includes("HOST_STREAM_OK")));
  assert.ok(framesB.some((f) => f.kind === "output" && f.data.includes("HOST_STREAM_OK")));
  assert.ok(framesA.every((f, n) => !n || f.sequence > framesA[n - 1]!.sequence));
  await service.detach({ ...scope, resourceEpoch: created.resourceEpoch }, b);
  const watermarkB = framesB.length;
  assert.ok(framesSame.some((f) => f.streamId === "view2"));
  await service.detach({ ...scope, resourceEpoch: created.resourceEpoch }, sameOwnerView);
  const watermarkSame = framesSame.length;
  await service.stop({ ...scope, resourceEpoch: created.resourceEpoch }, a);
  assert.ok(framesA.some((f) => f.kind === "status"));
  assert.equal(framesB.length, watermarkB);
  assert.equal(framesSame.length, watermarkSame, "关闭同连接另一视图不影响首个视图推送");
});

const terminal = {
  terminalId: "terminal-1",
  workspacePath: "/project",
  sessionId: "session-1",
  resourceEpoch: "epoch-1",
  sequence: 1,
  status: "running" as const,
  capability: "pty" as const,
  resizeSupported: true,
  createdAt: 1,
  updatedAt: 1,
  terminalOwnerId: "remote:a",
  controlAllowed: true,
};
const frame: RuntimeTerminalFrame = {
  type: "terminal.event",
  terminalId: terminal.terminalId,
  sessionId: terminal.sessionId,
  resourceEpoch: terminal.resourceEpoch,
  sequence: 2,
  at: 2,
  kind: "output",
  data: "live-output",
};
class RuntimeFixture implements GatewayRuntimeClient {
  listener?: (frame: RuntimeTerminalFrame) => void;
  hold?: Promise<void>;
  holdPing?: Promise<void>;
  enteredPing?: () => void;
  terminalOpens = 0;
  streamId?: string;
  detached: string[] = [];
  entered?: () => void;
  capability = true;
  async request<M extends RuntimeMethod>(
    method: M,
    _params: RuntimeParams<M>,
  ): Promise<RuntimeResult<M>> {
    let result: unknown;
    switch (method) {
      case "runtime.ping":
        this.enteredPing?.();
        await this.holdPing;
        result = {
          pong: true,
          protocolVersion: 2,
          desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
          picoHome: "/home",
          capabilities: [
            DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
            CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
            TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
            ...(this.capability ? [TERMINAL_STREAM_RUNTIME_CAPABILITY] : []),
          ],
        };
        break;
      case "terminal.ownershipCapabilities":
        result = { ownerIsolation: true };
        break;
      case "session.get":
        result = {
          session: {
            sessionId: terminal.sessionId,
            workspacePath: terminal.workspacePath,
            title: "终端",
            status: "active",
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
          },
        };
        break;
      case "terminal.list":
        result = { terminals: [terminal] };
        break;
      case "terminal.attach":
      case "terminal.create":
        this.terminalOpens++;
        this.streamId = (_params as { streamId?: string }).streamId;
        this.listener?.({ ...frame, ...(this.streamId ? { streamId: this.streamId } : {}) });
        this.entered?.();
        await this.hold;
        result = {
          terminal,
          resourceEpoch: terminal.resourceEpoch,
          sequence: 1,
          snapshot: "initial",
          truncated: false,
        };
        break;
      case "terminal.detach":
        this.detached.push(String((_params as { streamId?: string }).streamId));
        result = { detached: true };
        break;
      default:
        throw new Error(`Unexpected method ${method}`);
    }
    return parseRuntimeResult(method, result);
  }
  subscribeTerminalFrames(listener: (frame: RuntimeTerminalFrame) => void) {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  }
  subscribeSessionFrames() {
    return { dispose() {} };
  }
  async subscribe() {
    return { replay: { subscribed: true as const, events: [], hasMore: false }, dispose() {} };
  }
  close() {}
}
function gatewayFixture() {
  const runtime = new RuntimeFixture();
  let current = true;
  const access = new RuntimeAccessSession({
    config: { workspaces: [{ id: "project", name: "项目", path: terminal.workspacePath }] },
    principal: {
      id: "a",
      terminalOwnerId: "remote:a",
      permissions: ["workspace.read", "terminal.control"],
      workspaceIds: ["project"],
    },
    client: runtime,
    isCurrent: () => current,
  });
  const messages: Array<Parameters<RuntimeAccessEventSink["publish"]>[0] | { type: "reply" }> = [];
  const events = access.attachEvents({ publish: (message) => messages.push(message), close() {} });
  const request = (method = "terminal.attach") => ({
    version: 1,
    requestId: "r",
    workspaceId: "project",
    method,
    params: {
      sessionId: terminal.sessionId,
      ...(method === "terminal.attach" ? { terminalId: terminal.terminalId } : {}),
    },
  });
  return {
    runtime,
    access,
    events,
    messages,
    request,
    revoke: () => {
      current = false;
    },
  };
}

test("终端推送在授权 attach 答复后发送，拒绝其他实例、epoch 和已撤销接入", async () => {
  const f = gatewayFixture();
  try {
    f.runtime.listener?.(frame);
    assert.equal(f.messages.length, 0, "未附着不发送终端输出");
    await f.access.dispatch(f.request(), () => f.messages.push({ type: "reply" }));
    assert.deepEqual(
      f.messages.map((m) => m.type),
      ["reply", "terminal_frame"],
    );
    const count = f.messages.length;
    f.runtime.listener?.({
      ...frame,
      streamId: f.runtime.streamId!,
      terminalId: "another-terminal",
    });
    f.runtime.listener?.({ ...frame, streamId: f.runtime.streamId!, sessionId: "another-session" });
    f.runtime.listener?.({ ...frame, streamId: f.runtime.streamId!, resourceEpoch: "old-epoch" });
    assert.equal(f.messages.length, count);
    f.revoke();
    f.runtime.listener?.({ ...frame, streamId: f.runtime.streamId!, sequence: 3 });
    assert.equal(f.messages.length, count);
  } finally {
    f.access.close();
  }
});

test("事件连接更换时迟到的终端附着不能发布成功，旧 Host 明确拒绝实时终端", async () => {
  const f = gatewayFixture();
  try {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.runtime.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.entered = entered;
    const rejected = assert.rejects(
      f.access.dispatch(f.request(), () => assert.fail("迟到附着不能成功")),
      (error: unknown) => error instanceof GatewayError && error.outcome === "unknown",
    );
    await started;
    f.events.close();
    release();
    await rejected;
    assert.equal(f.messages.length, 0);
    assert.equal(f.runtime.detached.length, 1, "迟到的旧附着已释放");
    f.access.attachEvents({ publish() {}, close() {} });
    f.runtime.capability = false;
    await assert.rejects(
      f.access.dispatch(f.request(), () => assert.fail("旧 Host不能假装已支持")),
      (error: unknown) => error instanceof GatewayError && error.code === "UNSUPPORTED_CAPABILITY",
    );
  } finally {
    f.access.close();
  }
});

test("能力检查期间更换事件连接，旧终端创建不会执行或污染新代际", async () => {
  const f = gatewayFixture();
  try {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.runtime.holdPing = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.runtime.enteredPing = entered;
    const rejected = assert.rejects(
      f.access.dispatch(f.request("terminal.create"), () => assert.fail("旧请求不能成功")),
      (error: unknown) => error instanceof GatewayError && error.outcome === "not_executed",
    );
    await started;
    f.events.close();
    f.access.attachEvents({ publish: (message) => f.messages.push(message), close() {} });
    release();
    await rejected;
    assert.equal(f.runtime.terminalOpens, 0);
    await f.access.dispatch(f.request(), () => f.messages.push({ type: "reply" }));
    assert.deepEqual(
      f.messages.map((m) => m.type),
      ["reply", "terminal_frame"],
    );
  } finally {
    f.access.close();
  }
});
