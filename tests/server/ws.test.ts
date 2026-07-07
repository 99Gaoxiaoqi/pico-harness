// 4.3 WebSocket 流式推送 + cursor 多端同步测试。
//
// 验证:
// 1. WS 连接 → hello 握手响应(带当前 epoch)
// 2. SessionStore appendMessage → client 收到 message 事件
// 3. cursor 增量:连接时传 lastSeq=5 → 只收 seq>5 的持久事件
// 4. volatile 事件(text-delta)不推进 seq,且不过滤(实时推送)
// 5. epoch 变化(bumpEpoch)后,新事件触发 resync(旧 cursor 失效)
// 6. pushVolatile:向所有在线 client 广播流式片段(不落盘)
//
// 不走真实 engine.run(避免依赖 LLM provider),直接操作 SessionStore 触发事件。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { globalSessionManager } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";
import { startWebSocketServer, type WsServerHandle } from "../../src/server/ws.js";

/** 跨平台安全删除(Windows EBUSY/EPERM 退避重试) */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (String(err).includes("EBUSY") || String(err).includes("EPERM")) {
        await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

/** 等待条件成立或超时(轮询) */
async function waitFor<T>(
  getter: () => T,
  predicate: (v: T) => boolean,
  timeoutMs = 2000,
): Promise<NonNullable<T>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = getter();
    if (predicate(v)) return v as NonNullable<T>;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor 超时 (${timeoutMs}ms)`);
}

/** 找一个空闲端口:listen 0 让 OS 分配,再 close 复用 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("无法获取端口"));
      }
    });
    srv.on("error", reject);
  });
}

/** 收集 client 收到的所有 WS 消息(解析成对象) */
function collectMessages(ws: WebSocket): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (data) => {
    try {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    } catch {
      // 忽略非 JSON
    }
  });
  return received;
}

describe("WebSocket 流式推送 + cursor 多端同步", () => {
  let workDir: string;
  let httpServer: Server;
  let wsHandle: WsServerHandle;
  let port: number;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-ws-"));
    port = await findFreePort();
    httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(port, resolve));
    wsHandle = startWebSocketServer(httpServer);
    // 清理全局 SessionManager,隔离每个用例
    globalSessionManager.clear();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      wsHandle.close(() => resolve());
    });
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    globalSessionManager.clear();
    await safeRm(workDir);
  });

  /** 建一个带持久化的 session,返回其 id */
  async function makeSession(id: string): Promise<string> {
    await globalSessionManager.getOrCreate(id, workDir, { persistence: true });
    return id;
  }

  /** 建一条 WS 连接,自动等待 hello */
  async function connect(
    sessionId: string,
    lastSeq = 0,
    epoch = 0,
  ): Promise<{ ws: WebSocket; received: Array<Record<string, unknown>>; hello: Record<string, unknown> }> {
    const ws = new WebSocket(
      `ws://localhost:${port}/?sessionId=${sessionId}&lastSeq=${lastSeq}&epoch=${epoch}`,
    );
    // 关键:在 'open' 之前就挂 'message' 监听,避免快通道(hello 在 open 后极快到达)漏收。
    const received = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // 等 hello
    const hello = await waitFor(
      () => received[0],
      (v) => v !== undefined,
    );
    return { ws, received, hello };
  }

  it("WS 连接 → hello 握手响应(带 epoch=0)", async () => {
    const sid = await makeSession("ws-hello");
    const { ws, hello } = await connect(sid);
    expect(hello["type"]).toBe("hello");
    expect(hello["epoch"]).toBe(0);
    expect(hello["lastSeq"]).toBe(0);
    expect(hello["resync"]).toBeUndefined();
    ws.close();
  });

  it("appendMessage 持久事件 → client 收到 message 事件", async () => {
    const sid = await makeSession("ws-msg");
    const session = globalSessionManager.get(sid)!;
    // lastSeq=-1:接收所有 seq>=0 的持久事件(否则 seq<=lastSeq 会被 cursor 过滤)
    const { ws, received } = await connect(sid, -1);
    received.length = 0; // 清掉 hello

    await session.recordStore!.appendMessage(0, userMsg("hello world"));

    const evt = await waitFor(
      () => received[0],
      (v) => v !== undefined && v["type"] === "message",
    );
    expect(evt["seq"]).toBe(0);
    expect(evt["epoch"]).toBe(0);
    expect(evt["volatile"]).toBeUndefined();
    ws.close();
  });

  it("cursor 增量:lastSeq=5 → 只收 seq>5 的持久事件", async () => {
    const sid = await makeSession("ws-cursor");
    const session = globalSessionManager.get(sid)!;
    const store = session.recordStore!;
    // 先写入 seq 0..5(连接前)
    for (let i = 0; i <= 5; i++) {
      await store.appendMessage(i, userMsg(`old-${i}`));
    }
    // 以 lastSeq=5 连接:hello 后只应收到 seq>5 的事件
    const { ws, received } = await connect(sid, 5);
    received.length = 0;

    await store.appendMessage(6, userMsg("new-6"));
    await store.appendMessage(7, userMsg("new-7"));

    await waitFor(() => received.length, (n) => n >= 2);
    expect(received).toHaveLength(2);
    expect(received[0]!["seq"]).toBe(6);
    expect(received[1]!["seq"]).toBe(7);
    ws.close();
  });

  it("volatile 事件不推进 seq,且不参与 cursor 过滤(即使 seq 较小也推送)", async () => {
    const sid = await makeSession("ws-volatile");
    const session = globalSessionManager.get(sid)!;
    const store = session.recordStore!;
    // 先写一条持久 seq=10
    await store.appendMessage(10, userMsg("persisted"));
    // 以 lastSeq=10 连接(已收齐持久事件)
    const { ws, received } = await connect(sid, 10);
    received.length = 0;

    // 推一条 volatile(seq=10,不推进 cursor,但因 volatile 不过滤,仍推送)
    await store.appendMessage(10, userMsg("流式片段-1"), true);
    // 再推一条持久 seq=11(>10,推送并推进)
    await store.appendMessage(11, userMsg("persisted-2"));

    await waitFor(() => received.length, (n) => n >= 2);
    expect(received).toHaveLength(2);
    // 第一条:volatile,seq=10 但带 volatile:true
    expect(received[0]!["type"]).toBe("message");
    expect(received[0]!["volatile"]).toBe(true);
    expect(received[0]!["seq"]).toBe(10);
    // 第二条:持久 seq=11
    expect(received[1]!["volatile"]).toBeUndefined();
    expect(received[1]!["seq"]).toBe(11);
    ws.close();
  });

  it("epoch 变化后(bumpEpoch),新持久事件触发 resync", async () => {
    const sid = await makeSession("ws-epoch");
    const session = globalSessionManager.get(sid)!;
    const store = session.recordStore!;
    // 以 epoch=0 连接
    const { ws, received } = await connect(sid, 0, 0);
    received.length = 0;

    // bumpEpoch 模拟 fork/rewind
    store.bumpEpoch();
    // 写一条新持久事件 → listener 检测到 epoch>currentEpoch(0),推 resync
    await store.appendMessage(1, userMsg("after-fork"));

    const resyncEvt = await waitFor(
      () => received[0],
      (v) => v !== undefined && v["type"] === "resync",
    );
    expect(resyncEvt["type"]).toBe("resync");
    expect(resyncEvt["epoch"]).toBe(1);
    ws.close();
  });

  it("pushVolatile:向所有在线 client 广播流式片段(不落盘,不推进 seq)", async () => {
    const sid = await makeSession("ws-push");
    const { ws, received } = await connect(sid);
    received.length = 0;

    wsHandle.pushVolatile(sid, "流式片段-text-delta");

    const evt = await waitFor(
      () => received[0],
      (v) => v !== undefined && v["type"] === "text-delta",
    );
    expect(evt["type"]).toBe("text-delta");
    expect(evt["volatile"]).toBe(true);
    expect(evt["delta"]).toBe("流式片段-text-delta");
    expect(evt["seq"]).toBe(-1); // 不推进游标
    ws.close();
  });

  it("缺少 sessionId 参数 → 连接被关闭(4001)", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on("close", (code, reasonBuf) => {
        resolve({ code, reason: reasonBuf.toString() });
      });
      ws.on("error", () => {
        /* 部分环境 error 先触发,close 随后 */
      });
    });
    expect(closed.code).toBe(4001);
    expect(closed.reason).toContain("sessionId");
  });

  it("不存在的 session → 连接被关闭(4004)", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/?sessionId=nonexistent`);
    const closed = await new Promise<{ code: number }>((resolve) => {
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => {
        /* ignore */
      });
    });
    expect(closed.code).toBe(4004);
  });
});
