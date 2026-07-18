import assert from "node:assert/strict";
import test from "node:test";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../../apps/desktop/src/renderer/conversation/MarkdownText.js";
import { sanitizeTerminalText } from "../../src/tui/terminal-markdown-model.js";

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
