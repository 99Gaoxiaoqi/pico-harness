// TerminalReporter ANSI 增强测试(5.6):
// - colorizeDiff:+ 绿 / - 红 / @@ 青 / 其他 dim
// - onToolResult:成功时打印前 3 行摘要(不只字节数);错误时红色
// - spinner:onThinking 启动、onToolCall/Message 停止(interval 正确清理)
//
// 注意:ANSI 具体转义序列随 picocolors 版本可能变化,测试只检查关键行为
// (含工具名、摘要内容、清理了 interval),不硬编码 \x1b[32m 这类具体序列。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorizeDiff, TerminalReporter } from "../../src/engine/reporter.js";
import pc from "picocolors";

describe("colorizeDiff", () => {
  it("+ 行用绿色着色", () => {
    const out = colorizeDiff("+added line");
    expect(out).toContain(pc.green("+added line"));
    // 仍包含原文内容,确认没被吃掉
    expect(out).toContain("added line");
  });

  it("- 行用红色着色", () => {
    const out = colorizeDiff("-removed line");
    expect(out).toContain(pc.red("-removed line"));
    expect(out).toContain("removed line");
  });

  it("@@ hunk 头用青色着色", () => {
    const out = colorizeDiff("@@ -1,2 +1,3 @@");
    expect(out).toContain(pc.cyan("@@ -1,2 +1,3 @@"));
  });

  it("其他行用 dim 着色", () => {
    const out = colorizeDiff(" context line");
    expect(out).toContain(pc.dim(" context line"));
  });

  it("多行混合时按行独立着色,换行保留", () => {
    const diff = ["@@ -1,1 +1,1 @@", "-old", "+new", " unchanged"].join("\n");
    const out = colorizeDiff(diff);
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    // 每行都发生着色(输出 ≠ 原文)且保留原文内容。
    // 不硬编码 ANSI 序列,避免 picocolors 版本差异导致误判。
    expect(lines[0]).toContain("@@ -1,1 +1,1 @@");
    expect(lines[0]).not.toBe("@@ -1,1 +1,1 @@");
    expect(lines[1]).toContain("-old");
    expect(lines[1]).not.toBe("-old");
    expect(lines[2]).toContain("+new");
    expect(lines[2]).not.toBe("+new");
    expect(lines[3]).toContain(" unchanged");
    expect(lines[3]).not.toBe(" unchanged");
  });

  it("空字符串安全处理不崩溃", () => {
    expect(() => colorizeDiff("")).not.toThrow();
    expect(typeof colorizeDiff("")).toBe("string");
  });

  it("首字符区分:+- 前缀以外的加号不误判", () => {
    // " x+" 不是 + 行(首字符是空格),应该走 dim 分支
    const out = colorizeDiff(" x+something");
    expect(out).toContain(pc.dim(" x+something"));
  });
});

describe("TerminalReporter.onToolResult 摘要", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("成功时打印工具名 + 摘要前 3 行(不只字节数)", () => {
    const reporter = new TerminalReporter();
    const result = ["line1: 文件头部", "line2: 函数定义", "line3: 返回逻辑", "line4: 尾部"].join(
      "\n",
    );
    reporter.onToolResult("read_file", result, false);

    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    // 含工具名
    expect(out).toContain("read_file");
    // 含前 3 行内容(证明不只是字节数)
    expect(out).toContain("line1");
    expect(out).toContain("line2");
    expect(out).toContain("line3");
    // 第 4 行不应出现在摘要里
    expect(out).not.toContain("line4");
    // 含行数提示(超过 3 行)
    expect(out).toContain("共");
  });

  it("短结果(≤3 行)不显示'共 N 行'提示", () => {
    const reporter = new TerminalReporter();
    reporter.onToolResult("read_file", "only one line", false);
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(out).toContain("only one line");
    // 单行不该有"共 N 行"后缀
    expect(out).not.toMatch(/共 \d+ 行/);
  });

  it("每行摘要截断到 100 字符", () => {
    const reporter = new TerminalReporter();
    const long = "A".repeat(200);
    reporter.onToolResult("read_file", long, false);
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    // 截断后应是 100 个 A(摘要里出现 100 个 A,完整 200 不出现)
    expect(out).toContain("A".repeat(100));
    // 完整 200 A 在截断里不应连续出现
    expect(out).not.toContain("A".repeat(101));
  });

  it("空结果(纯空串)不打印摘要行", () => {
    const reporter = new TerminalReporter();
    logSpy.mockClear();
    reporter.onToolResult("bash", "", false);
    // 只有第一行(✅ + 字节数),没有 | 摘要行
    const calls = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(calls).toContain("bash");
    expect(calls).not.toContain("    | ");
  });

  it("错误结果:红色打印 + 截断到 200 字符", () => {
    const reporter = new TerminalReporter();
    const err = "B".repeat(300);
    reporter.onToolResult("bash", err, true);
    const out = logSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    // 含红色着色后的报错标记(picocolors.red 包裹"工具执行报错")
    expect(out).toContain(pc.red(`    -> ❌ 工具执行报错: ${"B".repeat(200)}`));
    // 实际打印的报错片段应是截断后(200 字符),不含 300 字符原文
    expect(out).toContain("B".repeat(200));
    expect(out).not.toContain("B".repeat(201));
  });
});

describe("TerminalReporter spinner", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("onThinking 启动 spinner,interval 在后续事件被清理", () => {
    const reporter = new TerminalReporter();
    reporter.onThinking();

    // 推进时间,spinner 应有输出(写 stdout)
    vi.advanceTimersByTime(240); // 3 帧 × 80ms
    const writes = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(writes).toContain("思考中");

    // 触发 onToolCall 应停止 spinner,清理 interval
    reporter.onToolCall("bash", "{}");
    // 再推进时间不应再产生 spinner 输出
    const writesBefore = writeSpy.mock.calls.length;
    vi.advanceTimersByTime(400);
    expect(writeSpy.mock.calls.length).toBe(writesBefore);

    // stopSpinner 应写过清行序列 \r\x1b[K
    const allWrites = writeSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(allWrites).toContain("\r\x1b[K");
  });

  it("onMessage 同样停止 spinner", () => {
    const reporter = new TerminalReporter();
    reporter.onThinking();
    vi.advanceTimersByTime(160);
    reporter.onMessage("done");

    const writesBefore = writeSpy.mock.calls.length;
    vi.advanceTimersByTime(400);
    expect(writeSpy.mock.calls.length).toBe(writesBefore);
  });

  it("无 spinner 时调用停止方法不崩(直接 onToolCall)", () => {
    const reporter = new TerminalReporter();
    expect(() => reporter.onToolCall("bash", "{}")).not.toThrow();
  });

  it("onFinish 停止 spinner", () => {
    const reporter = new TerminalReporter();
    reporter.onThinking();
    vi.advanceTimersByTime(160);
    reporter.onFinish();

    const writesBefore = writeSpy.mock.calls.length;
    vi.advanceTimersByTime(400);
    expect(writeSpy.mock.calls.length).toBe(writesBefore);
  });
});
