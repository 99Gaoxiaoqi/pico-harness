import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DEFAULT_VISIBLE_UPDATE_MS,
  IncrementalMarkdownRenderer,
  StreamingMarkdownSource,
  StreamingMarkdownView,
  VisibleUpdateScheduler,
  hashBlockText,
  parseMarkdownDocument,
  resolveVisibleUpdateMs,
  splitMarkdownDocument,
  splitStreamingBlocks,
  type MarkdownBlockParser,
} from "../../../apps/desktop/src/renderer/streaming-markdown/index.js";

const DOCUMENT = [
  "# 流式标题",
  "",
  "第一段包含 **加粗**、`行内代码` 和 [安全链接](https://example.com/docs)。",
  "",
  "> 引用一",
  ">",
  "> 引用二",
  "",
  "- 列表项一",
  "- 列表项二",
  "  - 子项",
  "",
  "1. 有序一",
  "2. 有序二",
  "",
  "| 左 | 右 |",
  "| :-- | --: |",
  "| 甲 | 乙 |",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "",
  "---",
  "",
  "最后一段",
].join("\n");

function chunked(source: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < source.length; index += size) {
    chunks.push(source.slice(index, index + size));
  }
  return chunks;
}

function countingParser(): { calls: string[]; parser: MarkdownBlockParser } {
  const calls: string[] = [];
  return {
    calls,
    parser: {
      parseBlock(text) {
        calls.push(text);
        return parseMarkdownDocument(text);
      },
      parseDocument: parseMarkdownDocument,
      splitDocument: splitMarkdownDocument,
    },
  };
}

test("Source 合并同一微任务内的 chunk，finish 后拒绝继续追加", async () => {
  const source = new StreamingMarkdownSource();
  const revisions: number[] = [];
  source.subscribe(() => revisions.push(source.getSnapshot().revision));

  source.append("第一");
  source.append("段");
  assert.equal(source.getSnapshot().text, "", "合并前不暴露半成品快照");
  await Promise.resolve();
  assert.equal(source.getSnapshot().text, "第一段");
  assert.deepEqual(revisions, [1], "同一微任务只提交一次");

  source.finish();
  assert.equal(source.getSnapshot().finished, true);
  assert.throws(() => source.append("迟到"), /already finished/u);
});

test("流式切块在代码块内不把空行当边界", () => {
  const blocks = splitStreamingBlocks("前文\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n尾");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]!.text, "前文");
  assert.equal(blocks[1]!.text, "```ts\nconst a = 1;\n\nconst b = 2;\n```");
  assert.equal(blocks[2]!.text, "尾");
  assert.deepEqual(
    blocks.map((block) => block.stable),
    [true, true, false],
  );
});

test("块哈希确定性且不同内容不冲突", () => {
  assert.equal(hashBlockText("# 标题"), hashBlockText("# 标题"));
  assert.notEqual(hashBlockText("# 标题"), hashBlockText("# 标题 "));
  assert.match(hashBlockText("任意内容"), /^[0-9a-f]{16}$/u);
});

test("追加尾部内容时已完成块保持 key，只重解析尾部块", () => {
  const { calls, parser } = countingParser();
  const renderer = new IncrementalMarkdownRenderer(parser);

  const first = renderer.update("# 标题\n\n第一段");
  assert.equal(calls.length, 2);
  const second = renderer.update("# 标题\n\n第一段继续");
  assert.equal(second[0]!.key, first[0]!.key, "已完成块 key 稳定");
  assert.notEqual(second[1]!.key, first[1]!.key, "尾部块 key 随内容变化");
  assert.equal(calls.filter((text) => text === "# 标题").length, 1, "已完成块只解析一次");
  assert.equal(calls.length, 3, "更新只解析尾部块");

  const repeated = renderer.update("# 标题\n\n第一段继续");
  assert.equal(calls.length, 3, "内容未变时命中缓存");
  assert.deepEqual(
    repeated.map((block) => block.key),
    second.map((block) => block.key),
  );

  const duplicate = renderer.update("同\n\n同");
  assert.notEqual(duplicate[0]!.key, duplicate[1]!.key, "重复内容也要有唯一 key");
});

test("任意 chunk 边界的增量结果与一次性解析全文一致", async () => {
  const source = new StreamingMarkdownSource();
  const renderer = new IncrementalMarkdownRenderer();
  let rendered: readonly { html: string }[] = [];
  for (const chunk of chunked(DOCUMENT, 17)) {
    source.append(chunk);
    await Promise.resolve(); // 让 Source 提交合并后的快照
    rendered = renderer.update(source.getSnapshot().text, false);
  }
  source.finish();
  const finished = renderer.update(source.getSnapshot().text, true);

  assert.ok(finished.length > 5, "最终应切出多个块");
  assert.equal(
    finished.map((block) => block.html).join(""),
    parseMarkdownDocument(DOCUMENT),
    "最终块级 HTML 拼接必须等于一次性解析",
  );
  assert.notEqual(rendered.length, 0, "流式过程中也要能渲染");
  assert.equal(renderer.stats.documentParses, 1, "finish 触发一次全量解析");
  assert.ok(renderer.stats.blockParses > 0);
});

test("finish 时按顶层 token 重新切块并修复流式近似结构", () => {
  const renderer = new IncrementalMarkdownRenderer();
  const loose = "- 一\n\n- 二\n\n  第二段";
  const streaming = renderer.update(loose, false);
  assert.equal(streaming.length, 3, "流式阶段按空行近似切块");
  const finished = renderer.update(loose, true);
  assert.equal(finished.length, 1, "最终解析合并为同一个松散列表");
  assert.equal(finished[0]!.html, parseMarkdownDocument(loose));
  assert.equal(finished[0]!.stable, true);
});

test("引用式链接回退到整篇解析，结果仍与一次性解析一致", () => {
  const document = "[文档][ref] 正文\n\n[ref]: https://example.com/reference";
  assert.equal(splitMarkdownDocument(document), null, "文档级定义无法按块独立解析");
  const renderer = new IncrementalMarkdownRenderer();
  const blocks = renderer.update(document, true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.html, parseMarkdownDocument(document));
  assert.match(blocks[0]!.html, /href="https:\/\/example\.com\/reference"/u);
  assert.equal(renderer.stats.documentParses, 1);
});

test("解析保持既有安全策略：无 HTML、无危险链接、图片为占位符", () => {
  const document = [
    "正文 <b>粗体</b>",
    "",
    "<script>alert(1)</script>",
    "",
    "[危险](javascript:alert(1)) 与 [数据](data:text/html,x)",
    "",
    "![示意图](https://example.com/private.png)",
  ].join("\n");
  const html = parseMarkdownDocument(document);
  assert.doesNotMatch(html, /<script|<b>/u);
  assert.doesNotMatch(html, /href="(?:javascript:|data:)/u);
  assert.match(html, /粗体/u);
  assert.match(html, /\[图片：示意图\]/u);
  assert.doesNotMatch(html, /<img/u);
});

test("增量渲染前清理控制字符，输出与清理后的全量解析一致", () => {
  const renderer = new IncrementalMarkdownRenderer();
  const blocks = renderer.update("# 标\r\n题\u0001", true);
  const html = blocks.map((block) => block.html).join("");
  assert.equal(html, parseMarkdownDocument("# 标\n题"));
  assert.equal(html.includes("\r"), false);
  assert.equal(html.includes("\u0001"), false);
});

test("SSR 渲染 finished 文档为块级结构，流式中标记为 active", () => {
  const finished = new StreamingMarkdownSource(
    "# 标题\n\n段落 **加粗**\n\n```ts\nconst a = 1;\n```",
  );
  finished.finish();
  const html = renderToStaticMarkup(
    createElement(StreamingMarkdownView, { source: finished, throttleMs: 0 }),
  );
  assert.match(html, /class="streaming-markdown" data-streaming="finished"/u);
  assert.match(html, /<h1>标题<\/h1>/u);
  assert.match(html, /<strong>加粗<\/strong>/u);
  assert.match(html, /<pre><code class="language-ts">/u);
  assert.match(html, /streaming-markdown__block/u);

  const streaming = new StreamingMarkdownSource("第一段");
  const active = renderToStaticMarkup(createElement(StreamingMarkdownView, { source: streaming }));
  assert.match(active, /data-streaming="active"/u);
  assert.match(active, /<p>第一段<\/p>/u);
});

test("可见更新节流窗口内只提交最后一次，flush 立即提交", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduler = new VisibleUpdateScheduler(50);
  const commits: string[] = [];
  scheduler.request(() => commits.push("a"));
  scheduler.request(() => commits.push("b"));
  assert.equal(commits.length, 0, "窗口内不提交");
  t.mock.timers.tick(49);
  assert.equal(commits.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(commits, ["b"], "只提交最后一次请求");

  scheduler.request(() => commits.push("c"));
  scheduler.flush();
  assert.deepEqual(commits, ["b", "c"], "flush 立即提交且不等待窗口");
  assert.equal(scheduler.isPending, false);
});

test("节流间隔默认为 50ms，允许配置且不为负", () => {
  assert.equal(resolveVisibleUpdateMs(undefined), DEFAULT_VISIBLE_UPDATE_MS);
  assert.equal(DEFAULT_VISIBLE_UPDATE_MS, 50);
  assert.equal(resolveVisibleUpdateMs(120), 120);
  assert.equal(resolveVisibleUpdateMs(0), 0);
  assert.equal(resolveVisibleUpdateMs(-10), 0);
  assert.equal(resolveVisibleUpdateMs(Number.NaN), DEFAULT_VISIBLE_UPDATE_MS);
});
