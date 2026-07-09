// 4.3 WebSocket 流式推送 + cursor 多端同步。
//
// client 连接:ws://host:port/?sessionId=xxx&lastSeq=NNN&epoch=EEE
// server 推送事件流,每条带 {seq, epoch, type, ...payload}:
//   - message     持久消息(来自 SessionStore record),推进 seq
//   - truncate/undo/rewind_to  历史改写事件,推进 seq
//   - text-delta  易失流式片段(不推进 seq),仅实时可见,不落盘不重放
//
// cursor 机制:
//   - seq 单调递增,持久事件推进;volatile 事件不推进
//   - client 重连传 lastSeq,server 只推 seq > lastSeq 的持久事件
//   - epoch:fork/rewind 时 epoch++。client 上报的 epoch ≠ 当前 epoch 时,
//     server 推一条 {type:"resync", epoch} 让 client 重拉全量(旧 cursor 失效)。

import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import { globalSessionManager } from "../engine/session.js";
import type { SessionRecord, SessionRecordListener } from "../engine/session-store.js";

/** 推给 client 的事件信封 */
export interface WsEvent {
  /** 事件类型(持久事件对应 SessionRecord.type;text-delta 为流式片段;resync 为世代变更信号) */
  type: "message" | "truncate" | "undo" | "rewind_to" | "text-delta" | "resync";
  /** 本事件的 seq(volatile 事件沿用上一条持久 seq 或 -1,client 不据此推进游标) */
  seq: number;
  /** 当前世代,client 据此判断是否需要 resync */
  epoch: number;
  /** 是否易失事件(不推进 client 游标) */
  volatile?: boolean;
  /** 事件负载(message 时为 Message;truncate 时为 fromIndex 等) */
  payload?: unknown;
  /** text-delta 时的流式文本片段 */
  delta?: string;
}

/** 一个已连接 client 的握手上下文(从 query 解析) */
interface ClientContext {
  ws: WebSocket;
  sessionId: string;
  /** client 已收到的最大持久 seq(重连增量用) */
  lastSeq: number;
  /** client 上报的世代(epoch 不匹配时 server 推 resync) */
  clientEpoch: number;
  /** 本连接订阅的取消函数 */
  unsubscribe?: () => void;
}

/**
 * 从 ws 连接 URL 解析握手参数。
 * 形如 /?sessionId=xxx&lastSeq=5&epoch=0。lastSeq/epoch 缺省为 0。
 */
function parseHandshake(url: string | undefined): { sessionId: string; lastSeq: number; clientEpoch: number } {
  const qIndex = url?.indexOf("?") ?? -1;
  const query = qIndex >= 0 ? url!.slice(qIndex + 1) : "";
  const params = new URLSearchParams(query);
  const sessionId = params.get("sessionId") ?? "";
  const lastSeq = Number.parseInt(params.get("lastSeq") ?? "0", 10);
  const clientEpoch = Number.parseInt(params.get("epoch") ?? "0", 10);
  return {
    sessionId,
    lastSeq: Number.isFinite(lastSeq) ? lastSeq : 0,
    clientEpoch: Number.isFinite(clientEpoch) ? clientEpoch : 0,
  };
}

/** 把 SessionRecord 翻译成可推送的 WsEvent。volatile message 不推进 seq。 */
function recordToEvent(record: SessionRecord, seq: number, epoch: number): WsEvent {
  const isVolatile = record.type === "message" && record.volatile === true;
  switch (record.type) {
    case "message":
      return {
        type: "message",
        // volatile 消息沿用传入 seq 但标记 volatile,client 不推进游标
        seq,
        epoch,
        ...(isVolatile ? { volatile: true } : {}),
        payload: record.message,
      };
    case "truncate":
      return { type: "truncate", seq, epoch, payload: { fromIndex: record.fromIndex } };
    case "undo":
      return { type: "undo", seq, epoch, payload: { count: record.count, at: record.at } };
    case "rewind_to":
      return {
        type: "rewind_to",
        seq,
        epoch,
        payload: { messageIndex: record.messageIndex, at: record.at },
      };
  }
  throw new Error(`未知 SessionRecord 类型: ${(record as { type: string }).type}`);
}

/**
 * 启动 WebSocket 服务,挂载到既有的 http.Server 上(共享端口)。
 * 返回一个控制句柄,可 pushVolatile 转发流式片段、close 收尾。
 */
export function startWebSocketServer(httpServer: Server): WsServerHandle {
  const wss = new WebSocketServer({ server: httpServer });
  /** sessionId → 该 session 的 client 集合(用于 broadcastVolatile) */
  const clientsBySession = new Map<string, Set<ClientContext>>();

  wss.on("connection", (ws: WebSocket, req) => {
    const { sessionId, lastSeq, clientEpoch } = parseHandshake(req.url);
    if (!sessionId) {
      ws.close(4001, "缺少 sessionId 参数");
      return;
    }
    const session = globalSessionManager.get(sessionId);
    const store = session?.recordStore;
    if (!session || !store) {
      ws.close(4004, `会话不存在或未开启持久化: ${sessionId}`);
      return;
    }

    const ctx: ClientContext = { ws, sessionId, lastSeq, clientEpoch };
    const currentEpoch = store.getEpoch();

    // 握手响应:告知 client 当前世代与起始 cursor。
    // 若 clientEpoch < currentEpoch,推 resync 让 client 重拉全量(旧 cursor 已失效)。
    ws.send(
      JSON.stringify({
        type: "hello",
        epoch: currentEpoch,
        lastSeq,
        ...(clientEpoch < currentEpoch ? { resync: true } : {}),
      }),
    );

    // 订阅 SessionStore 的 record 落盘事件。
    // 持久事件(message 非 volatile / truncate / undo / rewind_to):seq > lastSeq 才推。
    // volatile 事件(message volatile===true):总是推(实时流式),不参与 cursor 过滤。
    const listener: SessionRecordListener = (record, seq, epoch) => {
      if (ws.readyState !== ws.OPEN) return;
      const isVolatile = record.type === "message" && record.volatile === true;
      // 世代变更:旧 cursor 失效,推 resync(只推一次,由 hello 已处理的不重复)
      if (epoch > currentEpoch) {
        ws.send(JSON.stringify({ type: "resync", seq, epoch } satisfies WsEvent));
        return;
      }
      // 持久事件做 cursor 增量过滤;volatile 事件不过滤
      if (!isVolatile && seq <= ctx.lastSeq) return;
      const event = recordToEvent(record, seq, epoch);
      ws.send(JSON.stringify(event));
      // 持久事件推进 client 的 lastSeq(volatile 不推进)
      if (!isVolatile && seq > ctx.lastSeq) {
        ctx.lastSeq = seq;
      }
    };
    ctx.unsubscribe = store.onRecord(listener);

    // 登记到 clientsBySession(供 broadcastVolatile)
    let set = clientsBySession.get(sessionId);
    if (!set) {
      set = new Set();
      clientsBySession.set(sessionId, set);
    }
    set.add(ctx);

    ws.on("close", () => {
      ctx.unsubscribe?.();
      clientsBySession.get(sessionId)?.delete(ctx);
    });
    ws.on("error", () => {
      ctx.unsubscribe?.();
      clientsBySession.get(sessionId)?.delete(ctx);
    });
  });

  return {
    /** 向某 session 的所有在线 client 广播一条 volatile 流式片段(不落盘,不推进 seq) */
    pushVolatile(sessionId: string, delta: string): void {
      const session = globalSessionManager.get(sessionId);
      if (!session) return;
      const epoch = session.recordStore?.getEpoch() ?? 0;
      const set = clientsBySession.get(sessionId);
      if (!set || set.size === 0) return;
      const event: WsEvent = {
        type: "text-delta",
        seq: -1,
        epoch,
        volatile: true,
        delta,
      };
      const payload = JSON.stringify(event);
      for (const ctx of set) {
        if (ctx.ws.readyState === ctx.ws.OPEN) {
          ctx.ws.send(payload);
        }
      }
    },
    /** 关闭 WS 服务(收尾) */
    close(cb?: (err?: Error) => void): void {
      for (const set of clientsBySession.values()) {
        for (const ctx of set) ctx.unsubscribe?.();
      }
      clientsBySession.clear();
      wss.close(cb);
    },
  };
}

/** WS 服务控制句柄 */
export interface WsServerHandle {
  pushVolatile(sessionId: string, delta: string): void;
  close(cb?: (err?: Error) => void): void;
}
