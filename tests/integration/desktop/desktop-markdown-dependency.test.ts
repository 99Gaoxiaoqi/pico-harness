import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../../../apps/desktop/src/renderer/conversation/MarkdownText.js";

test("Desktop 声明 Markdown 解析器运行时依赖并渲染 Markdown", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../apps/desktop/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.ok(manifest.dependencies?.marked, "Desktop 必须直接声明 marked，不能依赖根项目 hoist");

  const html = renderToStaticMarkup(
    createElement(MarkdownText, { text: "# 标题\n\n**重点**与 `code`\n\n- 列表项" }),
  );
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong[^>]*>重点<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul[^>]*role="list"[\s\S]*<li[^>]*>[\s\S]*列表项[\s\S]*<\/li><\/ul>/);
  assert.match(html, /astryx-markdown/);
});
