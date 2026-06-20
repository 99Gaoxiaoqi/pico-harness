// Session 物理隔离与 WorkingMemory 截取的单元测试。
// 覆盖三个核心能力:
// 1. SessionManager.getOrCreate 多会话物理隔离
// 2. getWorkingMemory 滑动窗口截取最近 N 条
// 3. 孤儿 ToolResult 丢弃(规避大模型 API 400 Bad Request)

import { describe, expect, it } from "vitest";
import { Session, SessionManager } from "../src/engine/session.js";
import type { Message } from "../src/schema/message.js";

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}
function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

describe("Session", () => {
  it("append 追加消息并更新时间戳", () => {
    const sess = new Session("s1", "/tmp");
    expect(sess.length).toBe(0);
    const before = sess.updatedAt;
    sess.append(userMsg("hi"), assistantMsg("hello"));
    expect(sess.length).toBe(2);
    expect(sess.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("getHistory 返回浅拷贝,外部修改不影响内部", () => {
    const sess = new Session("s1", "/tmp");
    sess.append(userMsg("hi"));
    const h = sess.getHistory();
    h.push(userMsg("injected"));
    expect(sess.length).toBe(1);
  });

  it("getWorkingMemory:历史不足 limit 时全量返回", () => {
    const sess = new Session("s1", "/tmp");
    sess.append(userMsg("a"), assistantMsg("b"));
    const wm = sess.getWorkingMemory(6);
    expect(wm).toHaveLength(2);
    expect(wm[0]!.content).toBe("a");
  });

  it("getWorkingMemory:超过 limit 时截取最近 N 条", () => {
    const sess = new Session("s1", "/tmp");
    for (let i = 0; i < 10; i++) {
      sess.append(userMsg(`msg-${i}`));
    }
    const wm = sess.getWorkingMemory(4);
    // 截取最近 4 条:msg-6 ~ msg-9,首条 msg-6 是普通 user,不丢弃
    expect(wm).toHaveLength(4);
    expect(wm[0]!.content).toBe("msg-6");
    expect(wm[3]!.content).toBe("msg-9");
  });

  it("getWorkingMemory:limit<=0 时全量返回", () => {
    const sess = new Session("s1", "/tmp");
    sess.append(userMsg("a"), userMsg("b"), userMsg("c"));
    const wm = sess.getWorkingMemory(0);
    expect(wm).toHaveLength(3);
  });

  it("getWorkingMemory:截断首条是孤儿 toolResult 时被丢弃", () => {
    // 8 条历史,limit=3,截取最近 3 条:
    //   [toolResult(call-1), userMsg(闲聊6), assistantMsg(闲聊7)]
    // 首条 toolResult 是孤儿(发起它的 assistant 在截断之外),必须丢弃
    // 结果应为 [userMsg(闲聊6), assistantMsg(闲聊7)]
    const sess = new Session("s1", "/tmp");
    sess.append(
      userMsg("原始任务"),
      assistantMsg("我发起调用"), // toolCall 源头
      toolResultMsg("call-1", "result-1"), // toolResult
      userMsg("闲聊1"),
      assistantMsg("闲聊2"),
      toolResultMsg("call-1", "orphan-result"), // 这条会被截断到窗口首位
      userMsg("闲聊6"),
      assistantMsg("闲聊7"),
    );
    const wm = sess.getWorkingMemory(3);
    // 原始截取 = [toolResult(孤儿), userMsg(闲聊6), assistantMsg(闲聊7)]
    // 丢弃孤儿后 = [userMsg(闲聊6), assistantMsg(闲聊7)]
    expect(wm).toHaveLength(2);
    expect(wm[0]!.content).toBe("闲聊6");
    expect(wm[1]!.content).toBe("闲聊7");
    // 确认孤儿 toolResult 不在结果中
    expect(wm.some((m) => m.toolCallId === "call-1" && m.content === "orphan-result")).toBe(false);
  });

  it("getWorkingMemory:首条是普通 user 时不丢弃", () => {
    const sess = new Session("s1", "/tmp");
    sess.append(userMsg("任务"), assistantMsg("回复"), userMsg("追问"), assistantMsg("再回复"));
    const wm = sess.getWorkingMemory(2);
    expect(wm).toHaveLength(2);
    expect(wm[0]!.content).toBe("追问");
    expect(wm[1]!.content).toBe("再回复");
  });

  it("getWorkingMemory:连续多个孤儿 toolResult 全部丢弃", () => {
    // 极端情况:窗口里前几条都是孤儿 toolResult
    const sess = new Session("s1", "/tmp");
    sess.append(
      userMsg("任务"),
      assistantMsg("发起3个调用"),
      toolResultMsg("c1", "r1"),
      toolResultMsg("c2", "r2"),
      toolResultMsg("c3", "r3"),
      userMsg("继续"),
      assistantMsg("完成"),
    );
    // limit=5:截取 [toolResult(c1孤儿), toolResult(c2孤儿), toolResult(c3孤儿), userMsg(继续), assistantMsg(完成)]
    // 三个孤儿全丢弃 → [userMsg(继续), assistantMsg(完成)]
    const wm = sess.getWorkingMemory(5);
    expect(wm).toHaveLength(2);
    expect(wm[0]!.content).toBe("继续");
    expect(wm[1]!.content).toBe("完成");
  });

  it("getWorkingMemory 返回拷贝,修改不影响 Session 内部", () => {
    const sess = new Session("s1", "/tmp");
    sess.append(userMsg("a"), userMsg("b"));
    const wm = sess.getWorkingMemory(6);
    wm[0]!.content = "tampered";
    expect(sess.getHistory()[0]!.content).toBe("a");
  });
});

describe("SessionManager", () => {
  it("getOrCreate:同 id 复用同一 Session 实例", () => {
    const mgr = new SessionManager();
    const s1 = mgr.getOrCreate("chat-A", "/tmp/a");
    const s2 = mgr.getOrCreate("chat-A", "/tmp/a");
    expect(s1).toBe(s2);
    expect(mgr.size).toBe(1);
  });

  it("getOrCreate:不同 id 物理隔离,各自独立", () => {
    const mgr = new SessionManager();
    const sA = mgr.getOrCreate("chat-A", "/tmp/a");
    const sB = mgr.getOrCreate("chat-B", "/tmp/b");
    expect(sA).not.toBe(sB);
    expect(mgr.size).toBe(2);

    // 往 A 写消息,B 看不到
    sA.append(userMsg("A 的消息"));
    expect(sA.length).toBe(1);
    expect(sB.length).toBe(0);
    // 隔离验证:B 的工作记忆不含 A 的内容
    expect(sB.getWorkingMemory(10).some((m) => m.content === "A 的消息")).toBe(false);
  });

  it("get:获取已存在会话,不存在时返回 undefined", () => {
    const mgr = new SessionManager();
    expect(mgr.get("nope")).toBeUndefined();
    mgr.getOrCreate("exists", "/tmp");
    expect(mgr.get("exists")).toBeDefined();
  });

  it("clear:清空所有会话", () => {
    const mgr = new SessionManager();
    mgr.getOrCreate("a", "/tmp");
    mgr.getOrCreate("b", "/tmp");
    expect(mgr.size).toBe(2);
    mgr.clear();
    expect(mgr.size).toBe(0);
  });

  it("多会话并发追加互不干扰(物理隔离核心验证)", () => {
    const mgr = new SessionManager();
    const sessions = ["feishu:群1", "feishu:群2", "wechat:用户C"].map((id) =>
      mgr.getOrCreate(id, "/tmp"),
    );

    // 各自追加不同内容
    sessions[0]!.append(userMsg("群1在重构代码"));
    sessions[1]!.append(userMsg("群2在查日志"));
    sessions[2]!.append(userMsg("用户C在问问题"));

    // 每个 Session 的工作记忆只含自己的内容
    for (let i = 0; i < sessions.length; i++) {
      const wm = sessions[i]!.getWorkingMemory(10);
      expect(wm).toHaveLength(1);
    }
    expect(sessions[0]!.getWorkingMemory(10)[0]!.content).toBe("群1在重构代码");
    expect(sessions[1]!.getWorkingMemory(10)[0]!.content).toBe("群2在查日志");
    expect(sessions[2]!.getWorkingMemory(10)[0]!.content).toBe("用户C在问问题");
  });
});
