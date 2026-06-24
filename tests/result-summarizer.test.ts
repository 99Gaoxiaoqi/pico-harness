import { describe, expect, it } from "vitest";
import { summarizeToolResult } from "../src/tools/result-summarizer.js";

describe("summarizeToolResult", () => {
  it("测试输出优先保留失败用例和断言错误", () => {
    const summary = summarizeToolResult({
      toolName: "bash",
      arguments: '{"command":"npm test"}',
      output: [
        "PASS ok.test.ts",
        "FAIL broken.test.ts",
        "AssertionError: expected true to be false",
        "Tests 1 failed | 3 passed",
      ].join("\n"),
      isError: true,
      maxChars: 300,
    });

    expect(summary.strategy).toBe("bash-test");
    expect(summary.text).toContain("FAIL broken.test.ts");
    expect(summary.text).toContain("AssertionError");
  });

  it("tsc 输出优先保留 TS 诊断", () => {
    const summary = summarizeToolResult({
      toolName: "bash",
      arguments: '{"command":"npm run typecheck"}',
      output: "src/app.ts:10:5 - error TS2322: Type string is not assignable\nFound 1 error",
      maxChars: 300,
    });

    expect(summary.strategy).toBe("bash-tsc");
    expect(summary.text).toContain("TS2322");
  });

  it("bash 普通日志会提取中间错误行", () => {
    const output = `head\n${"x".repeat(2000)}\nCRITICAL code=E_STRESS_CONTEXT\n${"y".repeat(2000)}\ntail`;

    const summary = summarizeToolResult({
      toolName: "bash",
      arguments: '{"command":"cat app.log"}',
      output,
      maxChars: 400,
    });

    expect(summary.strategy).toBe("bash-error-lines");
    expect(summary.text).toContain("CRITICAL code=E_STRESS_CONTEXT");
    expect(summary.text).not.toContain("x".repeat(1000));
  });

  it("read_file 输出包含路径和 head/tail", () => {
    const summary = summarizeToolResult({
      toolName: "read_file",
      arguments: '{"path":"src/app.ts"}',
      output: `${"a".repeat(1000)}middle${"z".repeat(1000)}`,
      maxChars: 300,
    });

    expect(summary.strategy).toBe("read_file-head-tail");
    expect(summary.text).toContain("path: src/app.ts");
    expect(summary.truncated).toBe(true);
  });

  it("rg 短输出原样保留", () => {
    const output = "src/a.ts:1:needle";

    const summary = summarizeToolResult({
      toolName: "bash",
      arguments: '{"command":"rg needle"}',
      output,
      maxChars: 300,
    });

    expect(summary.strategy).toBe("rg-original");
    expect(summary.text).toBe(output);
  });
});
