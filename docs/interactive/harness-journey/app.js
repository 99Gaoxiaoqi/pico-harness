const stages = [
  {
    tag: '输入', label: '任务抵达', kind: 'CLIENT', owner: 'CLI / Desktop', glyph: '↘',
    title: '你的任务进入系统',
    summary: 'TUI 或 Desktop 把请求交给本机 daemon。界面负责收集输入和展示进度；执行内核在共享 Runtime 中运行。',
    insight: '同一个 Run 可以从不同界面发起，UI 不应各自维护一套 Agent 执行语义。',
    sources: [{ label: '系统边界', href: '../../../ARCHITECTURE.md' }, { label: 'CLI 客户端', href: '../../../packages/cli/src/tui/client-repl.tsx' }],
  },
  {
    tag: '装配', label: '运行准备', kind: 'HOST', owner: 'Pico Host', glyph: '⌘',
    title: '固定这次运行的边界',
    summary: 'AgentRuntime 解析工作区、Session、模型路由和运行环境，再装配 Provider、工具、审批与扩展。内核不在深层调用里重新猜测这些配置。',
    insight: '一次 Run 应有明确的身份、工作目录、模型快照和能力集合。',
    sources: [{ label: 'AgentRuntime', href: '../../../packages/pico-host/src/agent-runtime.ts' }, { label: 'RuntimeRun', href: '../../../packages/runtime/src/runtime-run.ts' }],
  },
  {
    tag: '上下文', label: '准备模型输入', kind: 'CONTEXT', owner: 'Runtime', glyph: '◌',
    title: '从事实构造一份请求视图',
    summary: 'Runtime 根据会话事实、当前任务、可用工具和预算，构造这一步模型能看到的内容。它可能是历史的投影或压缩视图，不是另一份事实账本。',
    insight: '模型请求是“此刻给模型看的材料”；RuntimeEvent 才保存执行发生过什么。',
    sources: [{ label: 'Run Read Model', href: '../../../packages/runtime/src/session-runtime-read-model.ts' }, { label: '上下文总览', href: '../../architecture/03-context.md' }],
  },
  {
    tag: '推理', label: '请求 Provider', kind: 'MODEL', owner: 'Provider', glyph: '✳',
    title: '模型给出文字或工具意图',
    summary: 'Provider 把统一请求转换成目标协议，并把响应转换回 Runtime 可理解的格式。一次响应可以同时包含文字和多个工具调用。',
    insight: 'Provider 负责一次模型交互；循环、工具副作用和会话持久化仍由 Harness 控制。',
    sources: [{ label: 'AI SDK Provider', href: '../../../packages/pico-host/src/provider/ai-sdk-provider.ts' }, { label: 'Provider 契约', href: '../../../packages/core/src/provider-interface.ts' }],
  },
  {
    tag: '能力门', label: '检查与执行工具', kind: 'TOOLS', owner: 'Registry + Host', glyph: '⌁',
    title: '工具意图先过执行边界',
    summary: '工具调用要匹配本轮绑定的能力，再经过安全策略、Hook、权限或审批，最后才交给具体执行器。多个工具也要按资源冲突规则调度。',
    insight: '工具定义出现在模型上下文里，只说明模型可以提出调用；运行时还会判断能否执行。',
    sources: [{ label: 'Tool Registry', href: '../../../packages/pico-host/src/tool-registry.ts' }, { label: 'Tool Scheduler', href: '../../../packages/runtime/src/tool-scheduler.ts' }],
  },
  {
    tag: '落账', label: '提交执行事实', kind: 'STORAGE', owner: 'RuntimeEventStore', glyph: '▤',
    title: '意图和结果分开成为事实',
    summary: '工具派发前记录操作已准备，执行后再提交结果。RuntimeEventStore 将事实与相关投影放进持久化边界，避免只凭屏幕输出判断执行结果。',
    insight: '“准备执行”与“结果已提交”是两个状态。外部副作用发生后，取消也不代表副作用自动撤销。',
    sources: [{ label: 'RuntimeEvent Store', href: '../../../packages/storage/src/sqlite/sqlite-runtime-event-store.ts' }, { label: '事件契约', href: '../../../packages/core/src/runtime-event.ts' }],
  },
  {
    tag: '继续', label: '观察并收尾', kind: 'CONTROL', owner: 'AgentEngine', glyph: '↗',
    title: '模型观察结果，再决定下一步',
    summary: 'Runtime 把工具结果放进下一步可读视图。AgentEngine 再请求模型，或根据预算、取消、Plan 与运行状态结束这次 Run。',
    insight: 'Run 完成是生命周期状态；任务是否正确，还需要看目标结果或独立 verifier。',
    sources: [{ label: 'AgentEngine', href: '../../../packages/runtime/src/agent-engine.ts' }, { label: '评测教程', href: '../../history/course/10-evaluation.md' }],
  },
];

const stationList = document.querySelector('#station-list');
const stepCount = document.querySelector('#step-count');
const progressFill = document.querySelector('#progress-fill');
const statusLabel = document.querySelector('#journey-status');
const prevButton = document.querySelector('#prev-step');
const nextButton = document.querySelector('#next-step');
let currentStage = 0;

function renderStationList() {
  stationList.replaceChildren();
  stages.forEach((stage, index) => {
    const item = document.createElement('li');
    item.className = 'station-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `station-button${index < currentStage ? ' is-complete' : ''}`;
    button.setAttribute('aria-label', `第 ${index + 1} 站：${stage.label}`);
    if (index === currentStage) button.setAttribute('aria-current', 'step');
    button.innerHTML = `<span class="station-number">${String(index + 1).padStart(2, '0')}</span><span class="station-label">${stage.label}</span><span class="station-kind">${stage.kind}</span>`;
    button.addEventListener('click', () => selectStage(index));
    item.append(button);
    stationList.append(item);
  });
}

function renderStage() {
  const stage = stages[currentStage];
  document.querySelector('#station-kicker').textContent = `STATION ${String(currentStage + 1).padStart(2, '0')}`;
  document.querySelector('#station-owner').textContent = stage.owner;
  document.querySelector('#station-glyph').textContent = stage.glyph;
  document.querySelector('#station-tag').textContent = stage.tag;
  document.querySelector('#station-title').textContent = stage.title;
  document.querySelector('#station-summary').textContent = stage.summary;
  document.querySelector('#station-insight').textContent = stage.insight;
  stepCount.textContent = `${String(currentStage + 1).padStart(2, '0')} / ${String(stages.length).padStart(2, '0')}`;
  progressFill.style.width = `${((currentStage + 1) / stages.length) * 100}%`;
  prevButton.disabled = currentStage === 0;
  nextButton.disabled = currentStage === stages.length - 1;
  nextButton.innerHTML = currentStage === stages.length - 1 ? '旅程完成 <span aria-hidden="true">✓</span>' : '下一步 <span aria-hidden="true">→</span>';
  statusLabel.textContent = currentStage === stages.length - 1 ? '本轮已收尾' : `第 ${currentStage + 1} 站 · 运行中`;
  const sourceLinks = document.querySelector('#source-links');
  sourceLinks.replaceChildren();
  stage.sources.forEach((source) => {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = source.href;
    link.textContent = source.label;
    link.title = `在项目中查看：${source.label}`;
    sourceLinks.append(link);
  });
  renderStationList();
}

function selectStage(index) {
  currentStage = Math.max(0, Math.min(stages.length - 1, index));
  renderStage();
}

prevButton.addEventListener('click', () => selectStage(currentStage - 1));
nextButton.addEventListener('click', () => selectStage(currentStage + 1));

const faultCases = {
  approval: {
    label: '场景 A · 执行前被拦下', heading: '审批被拒绝',
    explanation: '请求在工具产生副作用前被拒绝。Runtime 可以把拒绝结果交回执行循环，让 Agent 调整方案或向用户解释。',
    known: '这次受控工具操作被拒绝；拒绝本身可以作为运行事实。',
    boundary: '拒绝不会自动撤销此前已发生的其他操作。',
  },
  oversized: {
    label: '场景 B · 结果超过入口上限', heading: '工具结果太大',
    explanation: '单次工具结果在入口处有大小上限。超限时系统提交合成错误，引导 Agent 用更窄的命令读取所需部分。',
    known: '超限结果不会以完整正文进入 RuntimeEvent。',
    boundary: '提示模型“分段读取”不等于系统已经保存或自动切分了完整文件。',
  },
  interrupt: {
    label: '场景 C · 运行没有正常收尾', heading: '进程在工具执行时退出',
    explanation: '系统要先区分操作已准备、结果已提交和 Run 终态。重启后可以依据已落账的事实修复或恢复受支持的路径。',
    known: '持久事件说明已提交到哪里的事实；没有提交的结果不能当作成功。',
    boundary: '恢复不承诺从模型内部状态逐 token 无损续跑；外部副作用也不能凭取消或重启自动撤销。',
  },
  context: {
    label: '场景 D · 输入超过模型窗口', heading: '上下文需要治理',
    explanation: '运行时可以先用有界工具结果视图，再在安全切点尝试生成摘要检查点。摘要通过结构校验后，后续模型才使用新的读取视图。',
    known: '压缩检查点改变模型后续看到的历史视图。',
    boundary: '它不会删除 canonical RuntimeEvent；摘要通过校验也不代表无损复原每个细节。',
  },
};

function renderFault(key) {
  const fault = faultCases[key];
  document.querySelectorAll('.fault-choice').forEach((button) => {
  const active = button.dataset.fault === key;
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-pressed', String(active));
  });
  document.querySelector('#fault-label').textContent = fault.label;
  document.querySelector('#fault-heading').textContent = fault.heading;
  document.querySelector('#fault-explanation').textContent = fault.explanation;
  document.querySelector('#fault-known').textContent = fault.known;
  document.querySelector('#fault-boundary').textContent = fault.boundary;
}

document.querySelectorAll('.fault-choice').forEach((button) => {
  button.addEventListener('click', () => renderFault(button.dataset.fault));
});

document.querySelectorAll('.quiz-choice').forEach((button) => {
  button.addEventListener('click', () => {
    const correct = button.dataset.answer === 'no';
    document.querySelectorAll('.quiz-choice').forEach((choice) => {
      choice.classList.remove('is-correct', 'is-wrong');
    });
    button.classList.add(correct ? 'is-correct' : 'is-wrong');
    document.querySelector('#quiz-feedback').innerHTML = correct
      ? '<span class="feedback-icon" aria-hidden="true">✓</span><p><strong>答对了。</strong>披露只决定模型能提出哪些调用；Registry、权限策略和宿主执行边界仍会校验这次请求。</p>'
      : '<span class="feedback-icon" aria-hidden="true">↻</span><p><strong>再往前想一步：</strong>Schema 描述调用形式。执行还需要匹配当前 Run 的能力绑定，并经过运行时安全检查。</p>';
  });
});

renderStage();
renderFault('approval');
