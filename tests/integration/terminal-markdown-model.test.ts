import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Box, render } from "ink";
import React from "react";
import { TerminalMarkdownModel } from "../../src/tui/terminal-markdown-model.js";

test("TerminalMarkdownModel 的测量与 Ink 实际行数一致", async () => {
  const model = new TerminalMarkdownModel(
    ["# 标题", "", "一段足够长的文本用于验证终端换行行为。", "", "- 第一项", "- 第二项"].join("\n"),
  );
  const width = 16;
  const rendered = await renderModel(model, width);
  const actualRows = rendered.split("\n").length - 1;

  assert.equal(model.measure(width), actualRows);
  assert.equal(model.clip(0, model.measure(width), width).length, actualRows);
});

test("TerminalMarkdownModel.clip 返回完整渲染视觉行的切片", () => {
  const model = new TerminalMarkdownModel("第一行\n\n第二行\n第三行");
  const allRows = model.clip(0, undefined, 80);

  assert.deepEqual(model.clip(1, 2, 80), allRows.slice(1, 3));
});

test("TerminalMarkdownModel 在 Markdown 类型与终端宽度矩阵中共享同一视觉行", async () => {
  const documents = [
    "# 标题\n\n正文 **加粗** 与 *强调*",
    "1. 第一项有足够长的内容用于换行\n2. 第二项\n   - 嵌套项目",
    "> 引用第一行\n> 引用第二行",
    "| 名称 | 状态 |\n| --- | --- |\n| pico | **ok** |",
    "```ts\nconst value = 'long long long';\n```",
    "**未闭合\n\n```ts\nconst value = 1;",
    "中文连续文本用于验证窄终端的硬换行行为",
    "[安全链接](https://example.com/path) [危险](javascript:alert(1))",
  ];
  const cases = [8, 12, 16, 20, 30, 40, 80].flatMap((width) =>
    documents.map((document) => ({ width, document, model: new TerminalMarkdownModel(document) })),
  );
  const rendered = await renderNode(
    React.createElement(
      Box,
      { flexDirection: "column" },
      cases.map(({ model, width }, index) =>
        React.createElement(React.Fragment, { key: index }, model.render(width)),
      ),
    ),
    80,
  );
  const actualRows = renderedRows(rendered);
  let offset = 0;
  for (const { model, width, document } of cases) {
    const measured = model.measure(width);
    assert.deepEqual(
      model.clip(0, undefined, width),
      actualRows.slice(offset, offset + measured),
      `render rows must equal clip rows at width ${width}: ${document}`,
    );
    offset += measured;
  }
  assert.equal(offset, actualRows.length);
});

test("TerminalMarkdownModel 渲染视口切片时不重新解析 Markdown 残片", async () => {
  const model = new TerminalMarkdownModel(
    "1. 第一项有足够长的内容用于换行\n2. 第二项\n\n```ts\nconst value = 1;\n```",
  );
  const width = 12;
  const start = 2;
  const rows = 4;
  const rendered = await renderNode(model.render(width, false, start, rows), width);
  assert.deepEqual(renderedRows(rendered), model.clip(start, rows, width));
});

test("TerminalMarkdownModel preserves inline styles in the shared visual-row IR", () => {
  const model = new TerminalMarkdownModel("**bold** *em* ~~del~~ `code`");
  const styled = collectStyledText(model.render(80));

  assert.ok(styled.some((item) => item.text === "bold" && item.bold === true));
  assert.ok(styled.some((item) => item.text === "em" && item.italic === true));
  assert.ok(styled.some((item) => item.text === "del" && item.strikethrough === true));
  assert.ok(styled.some((item) => item.text === "code" && item.color === "yellow"));
  assert.equal(new TerminalMarkdownModel("```\nabc\n```").clip(0, 1, 1)[0], "a");
});

test("TerminalMarkdownModel list wrapping preserves every body character", () => {
  const source = "abcdefghijklmnop";
  const rows = new TerminalMarkdownModel(`- ${source}`).clip(0, undefined, 8);
  const reconstructed = rows.map((row) => row.slice(2)).join("");

  assert.equal(reconstructed, source);
  assert.ok(rows.every((row) => !row.includes("…")));
});

test("TerminalMarkdownModel preserves list and quote bodies when prefixes do not fit", () => {
  assert.deepEqual(new TerminalMarkdownModel("- abc").clip(0, undefined, 1), ["a", "b", "c"]);
  assert.deepEqual(new TerminalMarkdownModel("- abc").clip(0, undefined, 2), ["ab", "c"]);
  assert.deepEqual(new TerminalMarkdownModel("1. abc").clip(0, undefined, 3), ["abc"]);
  assert.deepEqual(new TerminalMarkdownModel("> abc").clip(0, undefined, 2), ["ab", "c"]);
});

async function renderModel(model: TerminalMarkdownModel, width: number): Promise<string> {
  return renderNode(model.render(width), width);
}

async function renderNode(node: React.ReactNode, width: number): Promise<string> {
  const stdout = new PassThrough();
  Object.defineProperty(stdout, "columns", { value: width });
  let rendered = "";
  stdout.on("data", (chunk) => {
    rendered += String(chunk);
  });
  const instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    interactive: false,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();
  instance.unmount();
  await instance.waitUntilExit();
  return rendered;
}

function renderedRows(rendered: string): string[] {
  const normalized = rendered.endsWith("\n") ? rendered.slice(0, -1) : rendered;
  return normalized.split("\n");
}

function collectStyledText(node: React.ReactNode): Array<{
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly color?: string;
}> {
  if (!React.isValidElement(node)) return [];
  const props = node.props as {
    readonly children?: React.ReactNode;
    readonly bold?: boolean;
    readonly italic?: boolean;
    readonly strikethrough?: boolean;
    readonly color?: string;
  };
  const directText = typeof props.children === "string" ? props.children : undefined;
  return [
    ...(directText
      ? [
          {
            text: directText,
            bold: props.bold,
            italic: props.italic,
            strikethrough: props.strikethrough,
            color: props.color,
          },
        ]
      : []),
    ...React.Children.toArray(props.children).flatMap((child) => collectStyledText(child)),
  ];
}
