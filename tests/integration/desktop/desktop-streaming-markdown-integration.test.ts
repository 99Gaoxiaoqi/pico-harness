import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

/**
 * 流式 Markdown 接线回归。
 *
 * 同一段 80ms 流式增长文本，分别用一次性 `MarkdownText` 与接入后的
 * `StreamingMarkdownText` 渲染：
 * - 确定性断言：已完成块的 DOM 节点在后续追加中保持同一实例（块级复用），
 *   且流结束后回落到 MarkdownText 的权威渲染；
 * - 帧时间只记录不断言（CI 机器差异），用于 PR 中的前后对比。
 */
test("流式 Markdown 接线：块级复用、结束后回落、长文本帧时间", { timeout: 180_000 }, async () => {
  const raw = await runRendererBrowserScenario(`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import './apps/desktop/src/renderer/layers.css';
import './apps/desktop/src/renderer/styles.css';
import './apps/desktop/src/renderer/motion.css';
import './apps/desktop/src/renderer/astryx-controls.css';
import './apps/desktop/src/renderer/conversation/conversation.css';
import './apps/desktop/src/renderer/conversation/markdown-astryx.css';
import './apps/desktop/src/renderer/conversation/astryx-chat.css';
import { PicoTheme } from './apps/desktop/src/renderer/astryx-provider.tsx';
import { MarkdownText } from './apps/desktop/src/renderer/conversation/MarkdownText.tsx';
import { StreamingMarkdownText } from './apps/desktop/src/renderer/conversation/StreamingMarkdownText.tsx';
import { ConversationTranscript } from './apps/desktop/src/renderer/conversation/ConversationTranscript.tsx';

const FRAME_MS = 80;
const FRAMES = 40;
const CHUNK = [
  '## 段落标题',
  '',
  '这是流式输出的一段说明文字，用于模拟真实助手回复的密度与标点。',
  '',
  '- 列表项一：包含 \`inline code\` 与 **强调**',
  '- 列表项二：包含 [链接](https://example.com/path)',
  '',
  '\`\`\`ts',
  'export function sample(value: number): number {',
  '  return value * 2;',
  '}',
  '\`\`\`',
  '',
  '> 引用块内容，继续增长。',
  '',
].join('\\n');

function textFor(frame) {
  return CHUNK.repeat(frame);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = { baseline: [], streaming: [] };
let phase = null;
let last = performance.now();
let running = true;
const sample = () => {
  if (!running) return;
  const now = performance.now();
  if (phase !== null) samples[phase].push(now - last);
  last = now;
  requestAnimationFrame(sample);
};

function stat(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    n: values.length,
    mean: round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1) ?? 0),
  };
}

const root = createRoot(document.getElementById('app'));

function Frame({ kind, frame, streaming }) {
  return (
    <div style={{ height: '800px', overflow: 'auto', padding: 16, width: '900px' }}>
      {kind === 'baseline' ? (
        <MarkdownText text={textFor(frame)} />
      ) : (
        <StreamingMarkdownText text={textFor(frame)} streaming={streaming} />
      )}
    </div>
  );
}

async function runPhase(kind, streaming) {
  await act(async () => {
    root.render(<PicoTheme><Frame kind={kind} frame={1} streaming={streaming} /></PicoTheme>);
    await wait(400);
  });
  phase = kind;
  last = performance.now();
  for (let frame = 2; frame <= FRAMES; frame += 1) {
    await act(async () => {
      root.render(<PicoTheme><Frame kind={kind} frame={frame} streaming={streaming} /></PicoTheme>);
      await wait(FRAME_MS);
    });
  }
  await wait(300);
  phase = null;
  return document.querySelector('.desktop-markdown')?.getBoundingClientRect().height ?? 0;
}

(async () => {
  requestAnimationFrame(sample);

  // 基线：一次性解析整份增长文本。
  const baselineHeight = await runPhase('baseline');

  // 接线后：块级复用 + 尾部增量解析。
  await act(async () => {
    root.render(<PicoTheme><Frame kind="streaming" frame={1} streaming /></PicoTheme>);
    await wait(400);
  });
  const firstBlock = document.querySelector('.streaming-markdown__block');
  if (!firstBlock) throw new Error('流式渲染未产出块');
  const firstBlockHtml = firstBlock.innerHTML;

  phase = 'streaming';
  last = performance.now();
  for (let frame = 2; frame <= FRAMES; frame += 1) {
    await act(async () => {
      root.render(<PicoTheme><Frame kind="streaming" frame={frame} streaming /></PicoTheme>);
      await wait(FRAME_MS);
    });
  }
  await wait(300);
  phase = null;

  const streamedHeight =
    document.querySelector('.streaming-markdown')?.getBoundingClientRect().height ?? 0;
  const blocksAfter = [...document.querySelectorAll('.streaming-markdown__block')];
  const reuse = {
    blockCount: blocksAfter.length,
    firstBlockReused: blocksAfter[0] === firstBlock && firstBlock.isConnected,
    firstBlockHtmlStable: blocksAfter[0]?.innerHTML === firstBlockHtml,
  };

  // 流结束：回落 MarkdownText 的权威全量渲染。
  await act(async () => {
    root.render(<PicoTheme><Frame kind="streaming" frame={FRAMES} streaming={false} /></PicoTheme>);
    await wait(200);
  });
  const finished = {
    markdown: document.querySelectorAll('.desktop-markdown').length,
    streamingDom: document.querySelectorAll('.streaming-markdown').length,
  };

  // 会话记录接线：流式助手消息走增量渲染；带媒体的消息保持 MarkdownText。
  const streamingItem = {
    id: 'm1',
    kind: 'assistantMessage',
    text: '## 标题\\n\\n正文 **加粗**',
    streaming: true,
  };
  const mediaItem = {
    id: 'm2',
    kind: 'assistantMessage',
    text: '附件 [文件](pico://artifact/abc123)',
    streaming: true,
    media: [],
  };
  await act(async () => {
    root.render(
      <PicoTheme>
        <ConversationTranscript items={[streamingItem, mediaItem]} />
      </PicoTheme>,
    );
    await wait(200);
  });
  const transcript = {
    streamingViews: document.querySelectorAll('.streaming-markdown').length,
    streamingBlocks: document.querySelectorAll('.streaming-markdown__block').length,
  };

  running = false;
  await fetch('/result', {
    method: 'POST',
    body: JSON.stringify({
      baseline: stat(samples.baseline),
      streaming: stat(samples.streaming),
      reuse,
      parity: { plainHeight: Math.round(baselineHeight * 100) / 100, streamedHeight: Math.round(streamedHeight * 100) / 100 },
      finished,
      transcript,
      textBytes: textFor(FRAMES).length,
    }),
  });
})().catch((error) =>
  fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error && error.stack ? error.stack : error) }) }),
);
`);

  const report = JSON.parse(raw) as {
    error?: string;
    reuse: { blockCount: number; firstBlockReused: boolean; firstBlockHtmlStable: boolean };
    finished: { markdown: number; streamingDom: number };
    transcript: { streamingViews: number; streamingBlocks: number };
    baseline: { p95: number };
    streaming: { p95: number };
    parity: { plainHeight: number; streamedHeight: number };
  };
  console.log("流式 Markdown 接线报告:", JSON.stringify(report));
  assert.equal(report.error, undefined, String(report.error));

  // 确定性：块级复用生效，稳定块节点与 HTML 跨追加保持不变。
  assert.ok(report.reuse.blockCount > 10, `块数量异常：${report.reuse.blockCount}`);
  // 确定性：同一文本下增量块渲染与一次性渲染的高度一致（排版不变形）。
  assert.ok(
    Math.abs(report.parity.plainHeight - report.parity.streamedHeight) <= 1,
    `排版高度不一致：${report.parity.plainHeight} vs ${report.parity.streamedHeight}`,
  );
  assert.equal(report.reuse.firstBlockReused, true, "首个已完成块在追加后未被复用");
  assert.equal(report.reuse.firstBlockHtmlStable, true, "首个已完成块的 HTML 发生变化");
  // 确定性：流结束后交回 MarkdownText 全量渲染。
  assert.ok(report.finished.markdown >= 1, "流结束后没有回落到 MarkdownText");
  // 确定性：会话记录里流式助手消息走增量渲染（含 pico:// 的消息内部回落）。
  assert.equal(report.transcript.streamingViews, 1, "会话记录未接入流式渲染");
  assert.ok(
    report.streaming.p95 < report.baseline.p95,
    `流式 p95 ${report.streaming.p95}ms 未优于基线 ${report.baseline.p95}ms`,
  );
});
