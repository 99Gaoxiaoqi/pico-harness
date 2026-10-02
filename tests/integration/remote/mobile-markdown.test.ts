import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeMediaReference } from "@pico/protocol/mobile";
import {
  parseMarkdown,
  referencedMediaIds,
  registeredMedia,
  type MarkdownBlock,
  type MarkdownInline,
} from "../../../apps/mobile/src/markdown.js";

const image: RuntimeMediaReference = {
  artifactId: "image 1",
  kind: "image",
  alt: "图表",
  mimeType: "image/png",
  sizeBytes: 100,
  digest: "a".repeat(64),
  source: "./chart.png",
};
const video: RuntimeMediaReference = {
  ...image,
  artifactId: "video",
  kind: "video",
  alt: "演示",
  mimeType: "video/mp4",
  source: "file:///workspace/demo.mp4",
};

function collectInline(blocks: readonly MarkdownBlock[]): MarkdownInline[] {
  return blocks.flatMap((block) => {
    if (block.type === "paragraph" || block.type === "heading") return [...block.inline];
    if (block.type === "quote") return collectInline(block.blocks);
    if (block.type === "list") return block.items.flatMap((item) => collectInline(item.blocks));
    if (block.type === "table") return [block.header, ...block.rows].flat(2);
    return [];
  });
}

test("移动端 Markdown 文档保留原生排版和嵌套登记媒体", () => {
  const text = [
    "# 标题",
    "",
    "正文 **加粗** *斜体* ~~删除~~ `const x = '<b>';` 与 [文档][docs]。",
    "",
    "> 引用正文 &amp; &#x4e2d; ![图表](pico://artifact/image%201)",
    "",
    "3. 第一项",
    "4. 第二项",
    "   - [x] 已完成",
    "   - [ ] 待完成 [演示](file:///workspace/demo.mp4)",
    "",
    "| 项目 | 图 |",
    "| :--- | ---: |",
    "| 数据 | ![图表](./chart.png) |",
    "",
    "```ts",
    "const example = '<script>静态代码</script>';",
    "```",
    "",
    "---",
    "",
    "[docs]: https://example.com/docs",
  ].join("\n");
  const document = parseMarkdown(text, [image, video]);
  assert.deepEqual(
    document.map((block) => block.type),
    ["heading", "paragraph", "quote", "list", "table", "code", "rule"],
  );
  const content = collectInline(document);
  assert.ok(content.some((node) => node.type === "text" && node.strong && node.text === "加粗"));
  assert.ok(content.some((node) => node.type === "text" && node.emphasis && node.text === "斜体"));
  assert.ok(content.some((node) => node.type === "text" && node.strike && node.text === "删除"));
  assert.ok(content.some((node) => node.type === "text" && node.code && node.text.includes("<b>")));
  assert.ok(
    content.some((node) => node.type === "text" && node.href === "https://example.com/docs"),
  );
  assert.ok(content.some((node) => node.type === "text" && node.text.includes("& 中")));
  assert.deepEqual(
    referencedMediaIds(text, [image, video]),
    new Set([image.artifactId, video.artifactId]),
  );
  const list = document.find((block) => block.type === "list");
  assert.ok(list?.type === "list");
  assert.equal(list.start, 3);
  const tasks = list.items[1]?.blocks.find((block) => block.type === "list");
  assert.ok(tasks?.type === "list");
  assert.deepEqual(
    tasks.items.map((item) => item.checked),
    [true, false],
  );
  const table = document.find((block) => block.type === "table");
  assert.ok(table?.type === "table");
  assert.deepEqual(table.align, ["left", "right"]);
});

test("移动端 Markdown 拦截未登记图片和危险链接，代码与 HTML 不加载媒体", () => {
  const hidden: RuntimeMediaReference = { ...image, artifactId: "hidden", source: "./hidden.png" };
  const text = [
    "![远程图片](https://example.com/private.png) ![伪造](pico://artifact/missing)",
    "",
    "[危险](javascript:alert(1)) [数据](data:text/html,unsafe) [本地](file:///etc/passwd)",
    "",
    "`![代码](./hidden.png)`",
    "",
    "```md",
    "![代码块](./hidden.png)",
    "```",
    "",
    "<div>![HTML](./hidden.png)</div>",
    "",
    "正文 <script>![脚本](./hidden.png)</script> <b>保留正文</b>\u0001\u0080",
  ].join("\n");
  const document = parseMarkdown(text, [hidden]);
  const content = collectInline(document);
  assert.equal(
    content.some((node) => node.type === "media"),
    false,
  );
  assert.equal(
    content.some((node) => node.type === "text" && node.href),
    false,
  );
  assert.deepEqual(referencedMediaIds(text, [hidden]), new Set());
  const renderedText = content
    .filter((node) => node.type === "text")
    .map((node) => node.text)
    .join("");
  assert.match(renderedText, /图片：远程图片，未加载/);
  assert.match(renderedText, /链接已拦截/);
  assert.match(renderedText, /保留正文/);
  assert.doesNotMatch(renderedText, /<script>|<b>/);
  assert.equal(renderedText.includes(String.fromCharCode(1)), false);
  assert.equal(renderedText.includes(String.fromCharCode(128)), false);
  assert.equal(registeredMedia("pico://artifact/image%201", [image]), image);
  assert.equal(registeredMedia("./chart.png", [image]), image);
  assert.equal(
    registeredMedia("https://example.com/private.png", [
      { ...image, source: "https://example.com/private.png" },
    ]),
    undefined,
  );
  assert.equal(registeredMedia("//example.com/private.png", [image]), undefined);
});
