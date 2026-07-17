import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import React from "react";
import { render } from "ink";
import {
  formatSessionReasoningStatus,
  type SessionSettings,
} from "../../src/input/session-settings.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { ModelRouter, type ModelRoute } from "../../src/provider/model-router.js";
import { buildSeparatorLine } from "../../src/tui/message-list.js";
import { MarkdownText } from "../../src/tui/markdown-text.js";
import { buildStatusBarText } from "../../src/tui/status-bar.js";
import { createTuiTerminalGridSession } from "../../src/tui/terminal-grid.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import { transcriptContentRows } from "../../src/tui/viewport-rows.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

test("一次 resize CPR 超时不会用过期 PTY 高度覆盖可信前端网格", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, {
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 120, writable: true },
    rows: { value: 30, writable: true },
  });

  let answerCursorQuery = true;
  stdout.on("data", (chunk) => {
    if (!answerCursorQuery || !String(chunk).includes("\u001b[6n")) return;
    queueMicrotask(() => stdin.write("\u001b[30;120R"));
  });

  const session = await createTuiTerminalGridSession(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    { CODEX_SHELL: "1", TERM: "xterm-256color" },
    10,
  );

  try {
    assert.equal(session.stdout.rows, 30);
    answerCursorQuery = false;
    Object.defineProperty(stdout, "rows", { value: 20, writable: true });
    stdout.emit("resize");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(session.stdout.rows, 30);
    // 结束生产代码为迟到 CPR 保留的隔离窗口，避免测试退出时留下待决清理。
    stdin.write("\u001b[20;120R");
  } finally {
    await session.dispose();
  }
});

test("唯一状态栏同时呈现会话、权限和 MCP 状态", () => {
  assert.equal(
    buildStatusBarText({
      phase: "idle",
      sessionMode: "new",
      permissionMode: "yolo",
      mcpSummary: "MCP 0/0",
      renderWidth: 120,
    }),
    "phase idle · mode new · perm yolo · MCP 0/0",
  );
});

test("运行中为紧随消息的 spinner 预留一行 transcript 空间", () => {
  assert.equal(transcriptContentRows(20, { newMessageNotice: false, spinner: true }), 19);
  assert.equal(transcriptContentRows(20, { newMessageNotice: true, spinner: true }), 18);
});

test("轮次分隔线在宽屏保持克制的短线", () => {
  assert.equal(buildSeparatorLine(4), "────");
  assert.equal(buildSeparatorLine(80), "─".repeat(24));
});

test("reasoning 状态显示已配置档位的中文说明", () => {
  const route: ModelRoute = {
    id: "codex-oauth/gpt-5.4",
    providerId: "codex-oauth",
    provider: "openai",
    model: "gpt-5.4",
    baseURL: "http://localhost/v1",
    apiKeyEnv: "TEST_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", "gpt-5.4", {
      reasoning: {
        enabled: true,
        defaultLevel: "medium",
        levels: ["low", "medium", "high"],
      },
    }),
  };
  const router = new ModelRouter([route], {}, route.id);
  const settings: SessionSettings = {
    sessionId: "test",
    sessionMode: "new",
    cwd: "/tmp",
    provider: "openai",
    mode: "yolo",
    permissionMode: "yolo",
    model: "gpt-5.4",
    modelRouteId: route.id,
    thinkingEffort: "off",
    thinkingEffortExplicit: false,
    tools: [],
    additionalDirectories: [],
  };

  assert.equal(
    formatSessionReasoningStatus(settings, router),
    [
      "路由：codex-oauth/gpt-5.4",
      "支持档位：low、medium、high",
      "默认档位：medium",
      "当前档位：medium",
      "用法：/thinking <low|medium|high>",
    ].join("\n"),
  );
});

test("思考过程与最终回答作为独立 transcript 条目流式投影", () => {
  const reporter = new TuiReporter(() => undefined);

  reporter.onThinking();
  reporter.onReasoningDelta("先分析");
  reporter.onReasoningDelta("项目。");
  reporter.onTextDelta("结论");
  reporter.onMessage("结论");

  assert.deepEqual(
    reporter.getProjection().entries.map(({ entry }) => entry),
    [
      { kind: "thinking" },
      { kind: "thinking", content: "先分析项目。" },
      { kind: "assistant", content: "结论" },
    ],
  );
  assert.deepEqual(
    Object.values(reporter.getProjection().streams).map(({ status }) => status),
    ["completed", "completed"],
  );
  assert.equal(
    buildTranscriptLayout([{ kind: "thinking", content: "先分析项目。" }], {
      wrapWidth: 80,
    }).contentRows,
    2,
  );
});

test("终端 Markdown 渲染嵌套行内样式且不回显标记", async () => {
  const rendered = await renderMarkdownFrame("**bold and *italic*** + `code`", true);

  assert.equal(rendered, "bold and italic + code\n");
  assert.equal(rendered.includes("**"), false);
  assert.equal(rendered.includes("*italic*"), false);
  assert.equal(rendered.includes("`"), false);
});

test("终端 Markdown 渲染块结构、任务列表和 GFM 表格", async () => {
  const rendered = await renderMarkdownFrame(
    [
      "# 标题",
      "",
      "> 引用",
      "",
      "- [x] 完成",
      "- [ ] 待办",
      "",
      "```ts",
      "const ok = true;",
      "```",
      "",
      "| 名称 | 状态 |",
      "| --- | --- |",
      "| pico | **ok** |",
    ].join("\n"),
  );

  assert.match(rendered, /标题/u);
  assert.match(rendered, /│ 引用/u);
  assert.match(rendered, /☑ 完成/u);
  assert.match(rendered, /☐ 待办/u);
  assert.match(rendered, /ts\n\s*const ok = true;/u);
  assert.match(rendered, /│ 名称 │ 状态 │/u);
  assert.match(rendered, /├───┼───┤/u);
  assert.match(rendered, /│ pico │ ok │/u);
});

test("终端 Markdown 忽略原始 HTML 并过滤控制序列和危险链接", async () => {
  const rendered = await renderMarkdownFrame(
    [
      "<script>alert('unsafe')</script>",
      "",
      "安全 <b>文本</b>",
      "",
      "\u001b[31m红色\u001b[0m [点击](javascript:alert(1)) [官网](https://example.com)",
      "\u001b]8;;https://evil.example\u0007OSC\u001b]8;;\u0007\u0007",
    ].join("\n"),
  );

  assert.match(rendered, /安全 文本/u);
  assert.match(rendered, /红色 点击 官网 \(https:\/\/example\.com\)/u);
  assert.match(rendered, /OSC/u);
  assert.equal(rendered.includes("script"), false);
  assert.equal(rendered.includes("unsafe"), false);
  assert.equal(rendered.includes("<b>"), false);
  assert.equal(rendered.includes("javascript:"), false);
  assert.equal(rendered.includes("evil.example"), false);
  assert.equal(rendered.includes("\u001b"), false);
  assert.equal(rendered.includes("\u0007"), false);
});

test("终端 Markdown 对未闭合流式片段保持可渲染", async () => {
  const rendered = await renderMarkdownFrame("**未闭合\n\n```ts\nconst value = 1;");

  assert.match(rendered, /未闭合/u);
  assert.match(rendered, /const value = 1;/u);
});

async function renderMarkdownFrame(content: string, dimColor = false): Promise<string> {
  const stdout = new PassThrough();
  Object.defineProperty(stdout, "columns", { value: 80 });
  let rendered = "";
  stdout.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const instance = render(
    React.createElement(MarkdownText, {
      content,
      dimColor,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      interactive: false,
      patchConsole: false,
    },
  );
  await instance.waitUntilRenderFlush();
  instance.unmount();
  await instance.waitUntilExit();
  return rendered;
}
