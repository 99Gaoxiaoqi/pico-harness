import assert from "node:assert/strict";
import test from "node:test";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../../../apps/desktop/src/renderer/conversation/MarkdownText.js";
import { sanitizeTerminalText } from "@pico/cli/tui/terminal-markdown-model";

test("Desktop 与 TUI 共用 Markdown 文本安全策略", () => {
  const input = "第一行\r\n第二行\u0001\u007f\u0080";
  assert.equal(sanitizeMarkdownText(input), "第一行\n第二行");
  assert.equal(sanitizeTerminalText(`\u001b[31m${input}\u001b[0m`), "第一行\n第二行");
  const desktopHtml = renderToStaticMarkup(createElement(MarkdownText, { text: `**${input}**` }));
  assert.equal(desktopHtml.includes("\r"), false);
  assert.equal(desktopHtml.includes("\u0001"), false);
  assert.equal(desktopHtml.includes("\u0080"), false);
  assert.equal(isSafeMarkdownHref("https://example.com"), true);
  assert.equal(isSafeMarkdownHref("#details"), true);
  assert.equal(isSafeMarkdownHref("javascript:alert(1)"), false);
  assert.equal(isSafeMarkdownHref("data:text/html,unsafe"), false);
});

test("Astryx Markdown 保留嵌套文档并阻止 HTML、危险链接和图片加载", () => {
  const text = [
    "# 文档",
    "",
    "> 引用 **加粗** 与 <b>正文</b>",
    "",
    "- 外层 <i>保留</i>",
    "  - 子项 `\u003cb\u003e代码\u003c/b\u003e`",
    "",
    "- [x] 已做",
    "- [ ] 待做",
    "",
    "| 左 <b>内容</b> | 右 |",
    "| :--- | ---: |",
    "| 单元格 | `\u003ci\u003e` |",
    "",
    "```html",
    "<script>保留代码</script>",
    "```",
    "",
    "<script>不应出现</script>",
    "",
    "[危险](javascript:alert(1)) [数据](data:text/html,unsafe) ![示意](https://example.com/private.png)",
    "",
    "[安全][safe] 与 https://example.com/plain",
    "",
    "[safe]: https://example.com/reference",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(MarkdownText, { text, dim: true }));
  assert.match(html, /desktop-markdown--dim/);
  assert.match(html, /<blockquote>[\s\S]*正文[\s\S]*<\/blockquote>/);
  assert.match(html, /子项/);
  assert.match(html, /&lt;b&gt;代码&lt;\/b&gt;/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /checked=""/);
  assert.match(html, /disabled="" readOnly=""/);
  assert.doesNotMatch(html, /pico-task-/);
  assert.match(html, /<table[\s\S]*内容[\s\S]*单元格/);
  assert.match(html, /&lt;script&gt;保留代码&lt;\/script&gt;/);
  assert.doesNotMatch(html, /不应出现|<script|<b>|<i>|<img|<link[^>]*preload/);
  assert.doesNotMatch(html, /href="(?:javascript:|data:)/);
  assert.match(html, /\[图片：示意\]/);
  assert.match(html, /href="https:\/\/example.com\/reference"/);
  assert.match(html, /href="https:\/\/example.com\/plain"/);
  assert.match(html, /rel="noopener noreferrer" target="_blank"/);
});
