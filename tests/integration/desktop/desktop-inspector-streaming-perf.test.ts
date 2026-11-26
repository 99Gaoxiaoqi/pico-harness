import assert from "node:assert/strict";
import test from "node:test";
import { runRendererBrowserScenario } from "./renderer-browser-fixture.js";

/**
 * 流式文本增长时，右侧检查器面板不得随流式提交重渲。
 *
 * 复现路径与真实渲染一致：
 * - `sessionFrames` 每 80ms 推一帧（transcript 权威水位推进 → trace/context 资源变更），
 *   与 SessionSubscriptionOwner 的 DELTA_FLUSH_MS 对齐；
 * - 同一个提交里「会话」长文本持续增长，模拟流式 markdown 的布局增长；
 * - InspectorPanelController 走真实 IPC 形状（window.pico.runtime）与真实刷新去抖。
 *
 * 「是否重渲」用 React DevTools 注入钩子读取提交阶段 fiber 的 PerformedWork 位，
 * 是确定性信号；帧时间只作记录，不做阈值断言，避免 CI 机器差异导致抖动。
 */
test("检查器面板在流式文本增长期间不为未变化的数据重渲", { timeout: 120_000 }, async () => {
  const raw = await runRendererBrowserScenario(`
import './apps/desktop/src/renderer/layers.css';
import './apps/desktop/src/renderer/styles.css';
import './apps/desktop/src/renderer/motion.css';
import './apps/desktop/src/renderer/astryx-controls.css';
import './apps/desktop/src/renderer/pages-astryx.css';
import './apps/desktop/src/renderer/workbar-panels/InspectorPanel.css';
import './apps/desktop/src/renderer/workbar-panels/InspectorTimeline.css';
import './apps/desktop/src/renderer/workbar-panels/ToolPanels.css';

const STREAM_FRAME_MS = 80;
const STREAM_FRAMES = 50;
const PERFORMED_WORK = 1;

const renders = { commits: 0, panel: 0, timeline: 0, unmatched: 0 };
// 提交开始时 root.current 已是待提交的树，DOM 节点仍指向上一棵树；
// 因此按 stateNode 身份在新树里定位宿主 fiber，读它的 PerformedWork 位。
function performedWork(root, element) {
  const stack = [root.current];
  while (stack.length > 0) {
    const fiber = stack.pop();
    if (!fiber) continue;
    if (fiber.stateNode === element) {
      // 宿主 fiber 自身的 PerformedWork 不可靠；向上取渲染它的组件（memo 的 fiber.type 即内层函数）。
      let owner = fiber.return;
      while (owner && typeof owner.type !== 'function') owner = owner.return;
      return owner ? (owner.flags & PERFORMED_WORK) === PERFORMED_WORK : undefined;
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return undefined;
}
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  isDisabled: false,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot: (_rendererId, root) => {
    renders.commits += 1;
    for (const [selector, key] of [
      ['.tool-panel--inspector', 'panel'],
      ['.inspector-timeline', 'timeline'],
    ]) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const performed = performedWork(root, element);
      if (performed === undefined) renders.unmatched += 1;
      else if (performed) renders[key] += 1;
    }
  },
  onCommitFiberUnmount: () => {},
  checkDCE: () => {},
};

const at = (index) => new Date(Date.UTC(2026, 10, 26, 9, 0, index % 60)).toISOString();
const pad = (index, width) => String(index).padStart(width, '0');

function buildStep(runIndex, turnIndex, stepIndex, kind) {
  const id = 'step-' + pad(runIndex, 2) + '-' + pad(turnIndex, 2) + '-' + pad(stepIndex, 2);
  return {
    id,
    eventId: 'event-' + id,
    turnId: 'turn-' + pad(runIndex, 2) + '-' + pad(turnIndex, 2),
    kind,
    title: kind === 'tool' ? '读取 packages/pico-host/src/session-subscription-owner.ts' : '模型调用',
    status: 'completed',
    at: at(stepIndex),
    durationMs: 120 + stepIndex * 7,
    ...(kind === 'model'
      ? {
          providerId: 'provider-a',
          modelId: 'model-a',
          purpose: 'main',
          inputTokens: 1200 + stepIndex,
          outputTokens: 340 + stepIndex,
          costStatus: 'reported',
          costCNY: 0.0123,
        }
      : {}),
    output: 'output line ' + stepIndex + '\\n'.repeat(28) + '结束标记 ' + id,
  };
}

function buildExecutionPage() {
  const runs = [];
  for (let runIndex = 0; runIndex < 8; runIndex += 1) {
    const steps = [];
    for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
      for (let stepIndex = 0; stepIndex < 5; stepIndex += 1) {
        steps.push(buildStep(runIndex, turnIndex, stepIndex, stepIndex % 2 === 0 ? 'model' : 'tool'));
      }
    }
    runs.push({
      runId: 'run-' + pad(runIndex, 2),
      invocationId: 'invocation-' + pad(runIndex, 2),
      status: runIndex === 0 ? 'running' : 'completed',
      at: at(runIndex),
      durationMs: 900 + runIndex * 37,
      steps,
    });
  }
  return {
    runs,
    coverage: {
      modelAttempts: 'physical',
      oversizedRunIds: [],
      missingModelCallRunIds: [],
      incompleteRunIds: [],
    },
    nextCursor: undefined,
  };
}

const executionPage = buildExecutionPage();
const summary = {
  runCount: 8,
  modelCalls: 80,
  toolCalls: 80,
  inputTokens: 120000,
  outputTokens: 40000,
  costCNY: 1.234,
  costStatus: 'reported',
};
const contextSnapshot = {
  generatedAt: at(0),
  latestRequest: {
    status: 'available',
    inputTokens: 48000,
    contextWindow: 200000,
    usageStatus: 'reported',
  },
};

let frameListener;
const ipc = { executionQuery: 0, context: 0, summary: 0 };
window.pico = {
  runtime: {
    'runtime.ping': async () => ({
      ok: true,
      value: { capabilities: ['memory-learning-v2'], picoHome: '/tmp/pico' },
    }),
    'session.execution.query': async () => {
      ipc.executionQuery += 1;
      return { ok: true, value: executionPage };
    },
    'session.context.get': async () => {
      ipc.context += 1;
      return { ok: true, value: { context: contextSnapshot } };
    },
    'session.execution.summary': async () => {
      ipc.summary += 1;
      return { ok: true, value: summary };
    },
  },
  sessionFrames: {
    subscribe: (listener) => {
      frameListener = listener;
      return { dispose: () => { frameListener = undefined; } };
    },
  },
};

const panelProps = {
  kind: 'inspector',
  workspacePath: '/workspace',
  sessionId: 'session-1',
  instanceId: 'inspector',
  active: true,
  readOnly: false,
  inspectorTab: 'timeline',
  onInspectorTabChange: () => {},
};

function streamingText(frame) {
  const chunk = '流式输出第 ' + frame + ' 段：面板必须在文本增长时保持静止。\\n';
  return chunk.repeat(Math.min(frame + 1, 40) * 4);
}

const frameDeltas = [];
const longTasks = [];
const observer =
  typeof PerformanceObserver === 'function'
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      })
    : undefined;
observer?.observe({ entryTypes: ['longtask'] });

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  // 静态 import 会先于 hook 赋值求值，React DevTools 注入只在 react-dom 首次求值时读取全局钩子；
  // 这里必须动态加载以先安装提交观察器。
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PicoTheme } = await import('./apps/desktop/src/renderer/astryx-provider.tsx');
  const { WorkbarPanelHost } = await import(
    './apps/desktop/src/renderer/workbar-panels/WorkbarPanelHost.tsx'
  );

  function Harness({ frame }) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 420px', height: '100%' }}>
        <pre
          id="stream"
          style={{ margin: 0, padding: 16, whiteSpace: 'pre-wrap', overflow: 'hidden', font: 'inherit' }}
        >
          {streamingText(frame)}
        </pre>
        <div style={{ height: '100%', overflow: 'auto' }}>
          <WorkbarPanelHost {...panelProps} />
        </div>
      </div>
    );
  }

  const host = document.getElementById('app');
  host.style.cssText = 'position:fixed;inset:0;width:1200px;height:800px';
  const root = createRoot(host);

  root.render(
    <PicoTheme>
      <Harness frame={0} />
    </PicoTheme>,
  );
  // 初次加载与首轮刷新落定后再开始计时。
  await wait(1200);
  if (!document.querySelector('.inspector-timeline')) {
    throw new Error('检查器时间线未挂载，流式回归场景无效');
  }
  // 自校验：首轮挂载/刷新必须被观测到，否则 PerformedWork 观测已失效，断言会假通过。
  if (renders.panel === 0) {
    throw new Error('未观测到检查器面板渲染，提交观测失效');
  }
  renders.commits = 0;
  renders.panel = 0;
  renders.timeline = 0;

  let last = performance.now();
  let running = true;
  const sample = () => {
    if (!running) return;
    const now = performance.now();
    frameDeltas.push(now - last);
    last = now;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  const startedAt = performance.now();
  for (let frame = 1; frame <= STREAM_FRAMES; frame += 1) {
    await wait(STREAM_FRAME_MS);
    // 真实流式提交：会话文本增长 + 父级重渲 + 权威水位推进（trace/context 资源变更）。
    root.render(
      <PicoTheme>
        <Harness frame={frame} />
      </PicoTheme>,
    );
    frameListener?.({ type: 'subscription.resource_changed', sessionId: 'session-1', resource: 'trace' });
    frameListener?.({ type: 'subscription.resource_changed', sessionId: 'session-1', resource: 'context' });
  }
  // 让最后一次去抖刷新落定。
  await wait(400);
  running = false;
  observer?.disconnect();
  await nextFrame();

  const elapsed = performance.now() - startedAt;
  const sorted = [...frameDeltas].sort((left, right) => left - right);
  const percentile = (ratio) =>
    sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  const round = (value) => Math.round(value * 100) / 100;
  const report = {
    windowMs: Math.round(elapsed),
    frames: frameDeltas.length,
    frameMean: round(frameDeltas.reduce((sum, value) => sum + value, 0) / Math.max(1, frameDeltas.length)),
    frameP95: round(percentile(0.95)),
    frameP99: round(percentile(0.99)),
    frameMax: round(sorted.at(-1) ?? 0),
    longTasks: longTasks.length,
    longTaskMs: round(longTasks.reduce((sum, value) => sum + value, 0)),
    commits: renders.commits,
    panelRenders: renders.panel,
    unmatchedFibers: renders.unmatched,
    timelineRenders: renders.timeline,
    executionQueries: ipc.executionQuery,
    contextQueries: ipc.context,
    summaryQueries: ipc.summary,
    streamFrames: STREAM_FRAMES,
  };
  await fetch('/result', { method: 'POST', body: JSON.stringify(report) });
})().catch((error) => {
  fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(error && error.stack ? error.stack : error) }) });
});
`);

  const report = JSON.parse(raw) as Record<string, number | string>;
  console.log("检查器流式性能报告:", JSON.stringify(report));
  assert.equal(report.error, undefined, String(report.error));
  // 50 帧流式窗口内数据未变化（同一 execution page / summary / context）：
  // 面板与时间线都不得重渲；任何一次重渲都意味着流式提交再次穿透到右侧面板。
  assert.equal(report.panelRenders, 0, `流式窗口内检查器面板重渲了 ${report.panelRenders} 次`);
  assert.equal(report.timelineRenders, 0, `流式窗口内时间线重渲了 ${report.timelineRenders} 次`);
});
