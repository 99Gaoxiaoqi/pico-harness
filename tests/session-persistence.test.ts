// Session 持久化(事件溯源 JSONL)的单元测试。
//
// 对标 kimi-code wire.jsonl:append 每条消息追加一行,truncateTo 追加折叠事件,
// 重启后通过 SessionManager.getOrCreate → recover 重放重建 history。
//
// 持久化开关通过构造参数显式传入 { persistence: true },
// 不再依赖环境变量(环境变量是进程级全局,vitest 并行跑测试文件时会相互污染)。
// 用 mkdtemp 创建独立临时目录,不污染工作区。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/engine/session.js";
import type { Message } from "../src/schema/message.js";

/** 显式开启持久化的 getOrCreate 选项 */
const ON = { persistence: true } as const;
const OFF = { persistence: false } as const;

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("Session 持久化(事件溯源 JSONL)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-sess-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /**
   * 关键:append 是 fire-and-forget 异步落盘。测试要可靠地等到磁盘写完,
   * 用 setTimeout 让真实 IO(appendFile 经 libuv 线程池)走完。
   * 微任务(await Promise.resolve())等不住真实文件 IO,必须让出事件循环。
   */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  it("append 落盘后,新进程 getOrCreate 能重建历史", async () => {
    // 第一次:创建会话,append 两条
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-X", workDir, ON);
    s1.append(userMsg("hello"), assistantMsg("world"));
    await flush();
    expect(s1.length).toBe(2);

    // 模拟重启:新建 SessionManager(内存清空),同 id 重建
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-X", workDir, ON);
    // recover 后历史应为 2 条,内容一致
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("hello");
    expect(s2.getHistory()[1]!.content).toBe("world");
  });

  it("truncateTo 落盘后,recover 正确折叠历史", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-trunc", workDir, ON);
    s1.append(userMsg("m0"), userMsg("m1"), userMsg("m2"), userMsg("m3"));
    await flush();
    // 截断,只保留 index=2 起(m2, m3)
    s1.truncateTo(2);
    await flush();
    expect(s1.length).toBe(2);

    // 重启恢复
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-trunc", workDir, ON);
    expect(s2.length).toBe(2);
    expect(s2.getHistory()[0]!.content).toBe("m2");
    expect(s2.getHistory()[1]!.content).toBe("m3");
  });

  it("恢复后再 append,seq 不回退(不覆盖旧记录)", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-seq", workDir, ON);
    s1.append(userMsg("first"));
    await flush();

    // 重启恢复,再 append 一条
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-seq", workDir, ON);
    expect(s2.length).toBe(1);
    s2.append(userMsg("second"));
    await flush();

    // 再重启,应看到两条(证明 seq 续上了,没有覆盖)
    const mgr3 = new SessionManager();
    const s3 = await mgr3.getOrCreate("chat-seq", workDir, ON);
    expect(s3.length).toBe(2);
    expect(s3.getHistory()[0]!.content).toBe("first");
    expect(s3.getHistory()[1]!.content).toBe("second");
  });

  it("多 Session 在持久化下物理隔离(各自独立文件)", async () => {
    const mgr1 = new SessionManager();
    const sA = await mgr1.getOrCreate("feishu:群A", workDir, ON);
    const sB = await mgr1.getOrCreate("feishu:群B", workDir, ON);
    sA.append(userMsg("群A的消息"));
    sB.append(userMsg("群B的消息"));
    await flush();

    // 重启恢复:两个会话互不串
    const mgr2 = new SessionManager();
    const rA = await mgr2.getOrCreate("feishu:群A", workDir, ON);
    const rB = await mgr2.getOrCreate("feishu:群B", workDir, ON);
    expect(rA.length).toBe(1);
    expect(rB.length).toBe(1);
    expect(rA.getHistory()[0]!.content).toBe("群A的消息");
    expect(rB.getHistory()[0]!.content).toBe("群B的消息");
  });

  it("sessionId 含特殊字符被清洗为安全文件名", async () => {
    // "feishu:群/1" 含 : 和 /,须清洗后才不会破坏路径
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("feishu:群/1", workDir, ON);
    s1.append(userMsg("特殊 id"));
    await flush();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("feishu:群/1", workDir, ON);
    expect(s2.length).toBe(1);
    expect(s2.getHistory()[0]!.content).toBe("特殊 id");
  });

  it("persistence:false 时持久化关闭,重启不恢复(纯内存)", async () => {
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-off", workDir, OFF);
    s1.append(userMsg("不会落盘"));
    await flush();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-off", workDir, OFF);
    // 持久化关闭 → recover 空操作 → 历史为空
    expect(s2.length).toBe(0);
  });
});

describe("SessionStore 末行撕裂容忍", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-tear-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  it("最后一行损坏(撕裂)时,recover 容忍跳过,不报错", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");
    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("chat-tear", workDir, ON);
    s1.append(userMsg("good-1"), userMsg("good-2"));
    await flush();

    // 人为撕裂:把文件末尾追加一行半截 JSON,模拟崩溃时 append 写一半
    // (不修改已有行,避免与 fire-and-forget 落盘顺序假设耦合)
    const file = `${workDir}/.claw/sessions/chat-tear.jsonl`;
    const content = await readFile(file, "utf8");
    // 末尾追加一个半截损坏行(未闭合的 JSON),模拟 append 写一半崩溃
    const torn = `${content}{"type":"message","seq":999,"message":{"ro`;
    await writeFile(file, torn);

    // 重启恢复:末行撕裂应被容忍,保留能解析的两条完整消息
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("chat-tear", workDir, ON);
    expect(s2.length).toBe(2); // good-1 + good-2,撕裂行被跳过
    const contents = s2.getHistory().map((m) => m.content).sort();
    expect(contents).toEqual(["good-1", "good-2"]);
  });

  it("首次启动(无文件)recover 为空历史,不报错", async () => {
    const mgr = new SessionManager();
    const s = await mgr.getOrCreate("chat-new", workDir, ON);
    expect(s.length).toBe(0);
  });
});
