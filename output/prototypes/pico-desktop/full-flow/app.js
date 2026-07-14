const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

const taskGroups = [
  {
    label: '需要你处理',
    tasks: [
      { id: 'approval', title: '实现审批中心的风险分级', meta: '等待批准 · 网络访问', time: '02:18', state: 'attention', view: 'task-running', dialog: 'approval' },
      { id: 'question', title: '确定 Session 数据保存位置', meta: '需要你的选择', time: '05:40', state: 'attention', view: 'task-running', dialog: 'ask' },
    ],
  },
  {
    label: '运行中',
    tasks: [
      { id: 'desktop', title: '实现桌面端任务工作台', meta: '正在运行测试 · 子代理 2/3', time: '12:42', state: 'running', view: 'task-running' },
      { id: 'provider', title: '补全 Provider 错误映射', meta: '正在分析 6 个失败样本', time: '04:51', state: 'running', view: 'task-running' },
    ],
  },
  {
    label: '待审阅',
    tasks: [
      { id: 'review', title: '增加 Rewind 检查点', meta: '6 个文件 · 测试通过', time: '14m', state: 'review', view: 'task-review' },
    ],
  },
  {
    label: '失败',
    tasks: [
      { id: 'failed', title: '连接项目 MCP Server', meta: '连续失败 3 次', time: '31m', state: 'failed', view: 'task-failed' },
    ],
  },
  {
    label: '已完成',
    tasks: [
      { id: 'done', title: '整理工具错误信息', meta: '已审阅 · 已合并', time: '昨天', state: 'done', view: 'task-completed' },
    ],
  },
];

const state = {
  selectedTask: 'desktop',
  paused: false,
  cancelled: false,
  selectedFile: 'approval',
  automationEnabled: true,
  skillEnabled: true,
  mcpEnabled: true,
  selectedWorkspace: 'pico-harness',
  draftPrompt: '修复 Session 恢复时的状态丢失，并增加一条集成测试。',
  toastTimer: null,
};

const routeLabel = {
  work: '工作',
  automations: '自动化',
  customize: '扩展',
  settings: '设置',
};

const parseRoute = () => {
  const raw = location.hash.slice(1) || 'work/task-running';
  const [pathname, query = ''] = raw.split('?');
  const [section = 'work', view = 'home'] = pathname.split('/');
  return { section, view, params: new URLSearchParams(query) };
};

const routeTo = (path, params = {}) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });
  location.hash = `${path}${search.size ? `?${search}` : ''}`;
};

const updateRouteParams = (updates) => {
  const { section, view, params } = parseRoute();
  Object.entries(updates).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') params.delete(key);
    else params.set(key, value);
  });
  location.hash = `${section}/${view}${params.size ? `?${params}` : ''}`;
};

const showToast = (message) => {
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

const icon = (name) => {
  const icons = {
    work: '<path d="M4 5.5h16v13H4z"/><path d="M8 5.5V3h8v2.5M4 10h16"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    spark: '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 14.8 6l-.3-2.6h-4L10.2 6a7 7 0 0 0-1.7 1.1l-2.4-1-2 3.4L6.1 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.7 1.1l.3 2.6h4l.3-2.6a7 7 0 0 0 1.7-1.1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 7 2 7 2 7H4s2 0 2-7"/><path d="M10 20h4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    sessions: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  };
  return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[name] ?? icons.work}</svg>`;
};

const statusDot = (stateName) => `<span class="state-dot ${stateName}" aria-hidden="true"></span>`;

const titlebar = ({ section = 'work', status = '本地运行时已连接' } = {}) => `
  <header class="titlebar">
    <div class="traffic" aria-label="窗口控制"><span></span><span></span><span></span></div>
    <div class="brand"><span class="brand-mark">P</span><span>Pico · ${routeLabel[section] ?? 'Desktop'}</span></div>
    <div class="title-actions">
      <div class="title-status"><span class="live-dot"></span>${status}</div>
      <button class="icon-button" data-action="command" aria-label="打开命令面板" title="命令面板">${icon('search')}</button>
      <button class="icon-button" data-action="notifications" aria-label="打开通知中心" title="通知中心">${icon('bell')}</button>
    </div>
  </header>`;

const globalNav = (active) => `
  <nav class="global-nav" aria-label="全局导航">
    <button class="nav-button ${active === 'work' ? 'active' : ''}" data-route="work/home" aria-label="工作" title="工作">${icon('work')}</button>
    <button class="nav-button ${active === 'automations' ? 'active' : ''}" data-route="automations" aria-label="自动化" title="自动化">${icon('clock')}</button>
    <button class="nav-button ${active === 'customize' ? 'active' : ''}" data-route="customize" aria-label="扩展" title="扩展">${icon('spark')}</button>
    <button class="nav-button ${active === 'settings' ? 'active' : ''}" data-route="settings" aria-label="设置" title="设置">${icon('settings')}</button>
    <div class="nav-spacer"></div>
    <button class="nav-button" data-action="sessions" aria-label="Session 工作库" title="Session 工作库">${icon('sessions')}</button>
    <div class="avatar">AX</div>
  </nav>`;

const taskRail = () => {
  const groups = taskGroups.map((group) => `
    <section class="task-group">
      <div class="group-label"><span>${group.label}</span><span>${group.tasks.length}</span></div>
      ${group.tasks.map((task) => `
        <button class="task-item ${task.id === state.selectedTask ? 'active' : ''} ${task.state === 'attention' ? 'attention' : ''}"
          data-action="select-task" data-task="${task.id}" data-view="${task.view}" data-dialog="${task.dialog ?? ''}">
          <span class="task-title">${task.title}</span>
          <span class="task-meta">${statusDot(task.state)}<span>${task.meta}</span><time>${task.time}</time></span>
        </button>`).join('')}
    </section>`).join('');

  return `
    <aside class="task-rail" aria-label="工作队列">
      <button class="workspace-switcher" data-action="workspace-menu">
        <span class="repo-mark">PH</span>
        <span class="repo-copy"><span class="repo-name">pico-harness</span><span class="repo-path">~/Code/pico-harness</span></span>
        <span aria-hidden="true">⌄</span>
      </button>
      <div class="task-create">
        <button class="new-task" data-action="new-task"><span>＋ 新建任务</span><span class="shortcut">⌘N</span></button>
        <button class="icon-button" data-action="task-filter" aria-label="筛选任务">≡</button>
      </div>
      <div class="task-list">${groups}</div>
      <div class="rail-footer"><span>LOCAL · main</span><span>7 个任务</span></div>
    </aside>`;
};

const taskHeader = ({ title, kicker, stateText, tone = '', status = 'running' }) => `
  <header class="task-header">
    <div class="task-heading"><div class="task-kicker">${kicker}</div><h1>${title}</h1></div>
    <div class="header-status ${tone}">${statusDot(status)}<span>${stateText}</span></div>
    <div class="task-header-actions">
      <button class="ghost-button" data-action="density">摘要视图</button>
      <button class="secondary-button" data-action="stop">停止</button>
    </div>
  </header>`;

const runningTimeline = () => `
  <div class="timeline" id="main-content">
    <div class="timeline-inner">
      <div class="date-rule">今天 10:14 · RUN 04</div>
      <article class="event">
        <div class="event-mark">你</div>
        <div class="event-body"><div class="event-head">任务要求 <time>10:14:02</time></div><p class="event-copy">把现有 TUI 能力重组为桌面工作台。首版必须覆盖任务管理、审批、子代理、Diff、Rewind、成本与 Trace。</p></div>
      </article>
      <article class="event">
        <div class="event-mark agent">P</div>
        <div class="event-body"><div class="event-head">Pico 制定计划 <time>10:14:10</time></div>
          <div class="plan-list">
            <div class="plan-line"><span class="check">✓</span><span>复用事件模型、审批与 Session 能力</span><time>0:18</time></div>
            <div class="plan-line"><span class="check">✓</span><span>建立 Workspace / Task / Run 信息层级</span><time>3:41</time></div>
            <div class="plan-line"><span class="current">→</span><span>接入执行时间线与子代理状态</span><time>进行中</time></div>
            <div class="plan-line"><span>○</span><span>运行集成测试并审阅变更</span><time>待处理</time></div>
          </div>
        </div>
      </article>
      <article class="event">
        <div class="event-mark">2A</div>
        <div class="event-body"><div class="event-head">并行检查现有能力 <span class="meta">2 个子代理</span></div>
          <div class="event-summary">
            <div class="event-summary-row"><span>A1</span><span>权限边界审查</span><span class="result">已完成</span></div>
            <div class="event-summary-row"><span>A2</span><span>Rewind 数据流检查</span><span class="result">58%</span></div>
          </div>
        </div>
      </article>
      <article class="event">
        <div class="event-mark">›_</div>
        <div class="event-body"><div class="event-head">运行针对性测试 <time>10:25:18 · 12s</time></div>
          <button class="event-summary wide" data-action="tool-detail">
            <span class="event-summary-row"><span>› bash</span><code>pnpm vitest run tests/integration/desktop-flow.test.ts</code><span class="result">运行中</span></span>
          </button>
        </div>
      </article>
      <article class="event">
        <div class="event-mark attention">!</div>
        <div class="event-body"><div class="event-head">等待你的批准 <time>10:26:44</time></div>
          <div class="approval-inline">
            <div class="approval-inline-head"><span>访问外部网络并更新依赖锁文件</span><span class="risk-label">中风险</span></div>
            <div class="approval-inline-body">
              <div class="command-block">pnpm install --lockfile-only</div>
              <div class="impact-grid"><span>工作目录　<b>pico-harness/</b></span><span>文件影响　<b>pnpm-lock.yaml</b></span><span>网络目标　<b>registry.npmjs.org</b></span><span>回退点　<b>checkpoint-04</b></span></div>
              <div class="inline-actions"><button class="secondary-button" data-action="deny-approval">拒绝</button><button class="primary-button" data-action="approval">查看并决定</button></div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </div>`;

const reviewTimeline = () => `
  <div class="timeline" id="main-content"><div class="timeline-inner">
    <div class="date-rule">今天 14:22 · RUN COMPLETE</div>
    <article class="event"><div class="event-mark success">✓</div><div class="event-body"><div class="event-head">任务执行完成 <time>14:22:08</time></div><p class="event-copy"><strong>已增加消息级 Rewind 检查点，并补充文件冲突保护。</strong>变更已写入隔离 worktree，等待你审阅后应用。</p></div></article>
    <article class="event"><div class="event-mark">Δ</div><div class="event-body"><div class="event-head">生成变更集 <span class="meta">6 个文件</span></div><div class="event-summary"><div class="event-summary-row"><span>Changes</span><span>+92 −28</span><span class="result">捕获完整</span></div><div class="event-summary-row"><span>Worktree</span><code>pico/review-rewind</code><span class="result">隔离</span></div></div></div></article>
    <article class="event"><div class="event-mark success">T</div><div class="event-body"><div class="event-head">验证通过 <time>1.34s</time></div><p class="event-copy">7 / 7 集成测试通过，测试后没有新的文件变化。</p></div></article>
    <article class="event"><div class="event-mark agent">P</div><div class="event-body"><div class="event-head">等待你的审阅</div><p class="event-copy">建议先检查 <code>src/runtime/approval.ts</code> 的审批范围，再决定应用或要求修改。</p><div class="inline-actions" style="justify-content:flex-start"><button class="secondary-button" data-action="request-changes">要求修改</button><button class="primary-button" data-action="complete-review">批准并应用</button></div></div></article>
  </div></div>`;

const failedTimeline = () => `
  <div class="timeline" id="main-content"><div class="timeline-inner">
    <div class="date-rule">今天 15:03 · BLOCKED</div>
    <article class="event"><div class="event-mark">M</div><div class="event-body"><div class="event-head">启动 MCP Server <time>15:01:14</time></div><p class="event-copy">正在连接 <code>linear-local</code>，transport 为 stdio。</p></div></article>
    <article class="event"><div class="event-mark failed">×</div><div class="event-body"><div class="event-head">连接失败 <span class="meta">第 3 / 3 次</span></div><div class="event-summary"><div class="event-summary-row"><span>错误</span><code>spawn linear-mcp ENOENT</code></div><div class="event-summary-row"><span>恢复</span><span>重载配置、重新发现 PATH、重启进程</span></div></div></div></article>
    <article class="event"><div class="event-mark attention">!</div><div class="event-body"><div class="event-head">任务被阻塞</div><p class="event-copy">连续 3 次无法启动 MCP Server。现场、文件变化和最后检查点已经保留。</p><div class="approval-inline"><div class="approval-inline-body"><div class="impact-grid"><span>最可能根因　<b>命令不在 PATH</b></span><span>副作用　<b>未修改文件</b></span><span>最后检查点　<b>checkpoint-02</b></span><span>可安全重试　<b>是</b></span></div><div class="inline-actions"><button class="secondary-button" data-action="rewind">回到检查点</button><button class="secondary-button" data-action="open-settings">修改配置</button><button class="primary-button" data-action="retry">重试此步骤</button></div></div></div></div></article>
  </div></div>`;

const completedTimeline = () => `
  <div class="timeline" id="main-content"><div class="timeline-inner">
    <div class="date-rule">昨天 18:40 · ARCHIVED RESULT</div>
    <article class="event"><div class="event-mark success">✓</div><div class="event-body"><div class="event-head">任务完成并通过审阅</div><p class="event-copy"><strong>已统一工具错误信息，并合入 main。</strong></p><div class="metric-grid" style="margin-top:10px"><div class="metric"><span>文件</span><strong>4</strong></div><div class="metric"><span>测试</span><strong>12 / 12</strong></div><div class="metric"><span>成本</span><strong>¥0.84</strong></div><div class="metric"><span>耗时</span><strong>06:18</strong></div></div><div class="inline-actions" style="justify-content:flex-start"><button class="secondary-button" data-action="sessions">查看 Session</button><button class="secondary-button" data-action="export-trace">导出 Trace</button><button class="ghost-button" data-action="archive">归档任务</button></div></div></article>
  </div></div>`;

const composer = () => `
  <div class="composer-wrap">
    <div class="composer">
      <textarea name="task-instruction" autocomplete="off" aria-label="给 Pico 的指令" placeholder="补充方向，例如：先不要改 UI，只整理事件模型…"></textarea>
      <div class="composer-bar">
        <button class="meta-button" data-action="input-mode">调整当前任务（Steer）⌄</button>
        <button class="meta-button" data-action="model-menu">GPT-5.4⌄</button>
        <button class="meta-button" data-action="permission-menu">逐次确认⌄</button>
        <div class="composer-spacer"></div><span class="composer-cost">¥0.84 · 45.1k</span>
        <button class="send-button" data-action="send" aria-label="发送指令">↑</button>
      </div>
    </div>
  </div>`;

const currentInspector = (view) => {
  if (view === 'task-failed') return `
    <section class="section"><div class="section-title"><span>阻塞原因</span><span>3 次失败</span></div><div class="notice failed">无法启动 <code>linear-mcp</code>。命令不在当前 GUI App 的 PATH 中。</div></section>
    <section class="section"><div class="section-title"><span>已尝试</span><span>自动恢复</span></div><div class="trace-list"><div class="trace-row"><span>15:01</span><span>重新连接 MCP</span><strong>失败</strong></div><div class="trace-row"><span>15:02</span><span>重新加载配置</span><strong>失败</strong></div><div class="trace-row"><span>15:03</span><span>重新发现 shell PATH</span><strong>失败</strong></div></div></section>
    <section class="section"><button class="primary-button wide" data-action="retry">重试此步骤</button></section>`;

  if (view === 'task-review') return `
    <section class="section"><div class="section-title"><span>完成摘要</span><span>等待审阅</span></div><p class="event-copy">增加消息级 Rewind 检查点与指纹冲突保护。</p></section>
    <section class="section"><div class="metric-grid"><div class="metric"><span>文件</span><strong>6</strong></div><div class="metric"><span>变更</span><strong>+92 −28</strong></div><div class="metric"><span>测试</span><strong>7 / 7</strong></div><div class="metric"><span>成本</span><strong>¥1.84</strong></div></div></section>
    <section class="section"><div class="notice">运行位置是隔离 worktree。批准后将应用到 <code>main@4f29c8a</code>。</div></section>`;

  return `
    <section class="section"><div class="section-title"><span>当前动作</span><span>等待你</span></div><div class="notice attention">Agent 请求访问外部网络并更新依赖锁文件。</div></section>
    <section class="section"><div class="kv-list"><div class="kv"><span>命令</span><code>pnpm install</code></div><div class="kv"><span>工作目录</span><strong>pico-harness/</strong></div><div class="kv"><span>网络目标</span><strong>registry.npmjs.org</strong></div><div class="kv"><span>风险</span><strong>中</strong></div></div></section>
    <section class="section"><div class="metric-grid"><div class="metric"><span>改动</span><strong>5 files</strong></div><div class="metric"><span>上下文</span><strong>38.2k</strong></div><div class="metric"><span>成本</span><strong>¥0.84</strong></div><div class="metric"><span>缓存</span><strong>61%</strong></div></div></section>
    <section class="section"><button class="primary-button wide" data-action="approval">查看并决定</button></section>`;
};

const changesInspector = (expanded = false) => `
  <div class="diff-toolbar"><button class="scope-button active">当前任务</button><button class="scope-button">本轮</button><button class="scope-button">工作区</button></div>
  <section class="section"><div class="section-title"><span>文件</span><span>6 · +92 −28</span></div><div class="file-list">
    ${[
      ['M', 'src/runtime/approval.ts', '+34 −12', 'approval'],
      ['A', 'src/runtime/risk-summary.ts', '+21', 'risk'],
      ['M', 'tests/approval-flow.test.ts', '+28 −8', 'test'],
      ['M', 'src/runtime/types.ts', '+5 −2', 'types'],
    ].map(([kind, path, stat, id]) => `<button class="file-row ${state.selectedFile === id ? 'active' : ''}" data-action="select-file" data-file="${id}"><span class="file-kind">${kind}</span><span class="file-path">${path}</span><span class="file-stat">${stat}</span></button>`).join('')}
  </div></section>
  ${expanded ? `<div class="diff-view"><div class="diff-title"><span>src/runtime/approval.ts</span><span>+34 −12</span></div><div class="diff-code"><div class="diff-line"><span class="ln">47</span><span></span><code>const requestId = crypto.randomUUID();</code></div><div class="diff-line del"><span class="ln">48</span><span class="sign">−</span><code>const message = formatCommand(command);</code></div><div class="diff-line add"><span class="ln">48</span><span class="sign">+</span><code>const risk = summarizeRisk(request);</code></div><div class="diff-line add"><span class="ln">49</span><span class="sign">+</span><code>const rewindPoint = await capture();</code></div><div class="diff-line add"><span class="ln">50</span><span class="sign">+</span><code>return ui.requestApproval({ risk, rewindPoint });</code></div></div></div><div class="test-banner"><span>✓</span><span>验证通过</span><span>7 / 7 · 1.34s</span></div>` : ''}`;

const agentsInspector = () => `
  <section class="section"><div class="section-title"><span>子代理</span><span>2 / 3</span></div><div class="agent-list">
    <button class="agent-row" data-action="agent-detail"><span class="agent-mark">A1</span><span class="agent-copy"><strong>权限边界审查</strong><span>检查审批、沙箱和 hardline</span></span><span class="agent-state">完成</span></button>
    <button class="agent-row" data-action="agent-detail"><span class="agent-mark">A2</span><span class="agent-copy"><strong>Rewind 数据流</strong><span>验证指纹冲突保护</span></span><span class="agent-state running">58%</span></button>
    <button class="agent-row" data-action="agent-detail"><span class="agent-mark">A3</span><span class="agent-copy"><strong>Windows 兼容检查</strong><span>等待共享接口定义</span></span><span class="agent-state">排队</span></button>
  </div></section>
  <section class="section"><div class="section-title"><span>共享上下文</span><span>12.4k</span></div><p class="event-copy">只同步任务目标、接口约束和必要文件；子代理工具输出保留在各自 Trace。</p></section>`;

const traceInspector = () => `
  <section class="section"><div class="section-title"><span>Trace</span><span>local-7F2A</span></div><div class="trace-list"><div class="trace-row"><span>10:14:10</span><span>model.plan</span><strong>2.1s</strong></div><div class="trace-row"><span>10:16:33</span><span>subagent.spawn × 2</span><strong>ok</strong></div><div class="trace-row"><span>10:20:45</span><span>file.edit × 5</span><strong>4.8s</strong></div><div class="trace-row"><span>10:25:18</span><span>bash.test</span><strong>12.0s</strong></div><div class="trace-row"><span>10:26:44</span><span>approval.wait</span><strong>open</strong></div></div></section>
  <section class="section"><div class="metric-grid"><div class="metric"><span>Provider</span><strong>7</strong></div><div class="metric"><span>工具</span><strong>18</strong></div><div class="metric"><span>Token</span><strong>45.1k</strong></div><div class="metric"><span>成本</span><strong>¥0.84</strong></div></div></section>
  <section class="section"><button class="secondary-button wide" data-action="export-trace">导出原始 Trace</button></section>`;

const inspector = (view, activeTab) => {
  const content = activeTab === 'agents' ? agentsInspector() : activeTab === 'changes' ? changesInspector(view === 'task-review') : activeTab === 'trace' ? traceInspector() : currentInspector(view);
  const defaultBadge = view === 'task-review' ? '6 个文件' : view === 'task-failed' ? '需要处理' : '执行现场';
  return `
    <aside class="inspector" aria-label="现场与审阅">
      <div class="inspector-head"><div class="inspector-title"><small>Inspector</small><strong>${view === 'task-review' ? '结果审阅' : view === 'task-failed' ? '失败恢复' : '任务现场'}</strong></div><span class="inspector-badge">${defaultBadge}</span></div>
      <div class="tabs" role="tablist">
        ${['current', 'changes', 'agents', 'trace'].map((tab) => `<button class="tab ${activeTab === tab ? 'active' : ''}" role="tab" aria-selected="${activeTab === tab}" data-action="inspector-tab" data-tab="${tab}">${{ current: '当前', changes: 'Changes', agents: 'Agents', trace: 'Trace' }[tab]}</button>`).join('')}
      </div>
      <div class="inspector-body">${content}</div>
      <div class="inspector-footer">${view === 'task-review' ? '<button class="secondary-button" data-action="request-changes">要求修改</button><button class="primary-button" data-action="complete-review">批准并应用</button>' : '<button class="secondary-button wide" data-action="open-editor">在编辑器打开 ↗</button>'}</div>
    </aside>`;
};

const controlbar = (view) => {
  if (view === 'task-review') return `<footer class="controlbar"><span class="control-meta">隔离 worktree · main@4f29c8a</span><div class="control-spacer"></div><button class="control-button" data-action="rewind">↶ Rewind</button><button class="control-button" data-action="request-changes">要求修改</button><button class="control-button primary" data-action="complete-review">批准并应用</button></footer>`;
  if (view === 'task-failed') return `<footer class="controlbar"><span class="control-meta">现场已保留 · checkpoint-02</span><div class="control-spacer"></div><button class="control-button" data-action="rewind">↶ Rewind</button><button class="control-button" data-action="open-settings">修改配置</button><button class="control-button primary" data-action="retry">重试此步骤</button></footer>`;
  if (view === 'task-completed') return `<footer class="controlbar"><span class="control-meta">已完成 · main · trace-91DF</span><div class="control-spacer"></div><button class="control-button" data-action="sessions">查看 Session</button><button class="control-button" data-action="archive">归档</button></footer>`;
  return `<footer class="controlbar"><span class="control-meta">GPT-5.4 · 逐次确认</span><div class="control-spacer"></div><button class="control-button primary" data-action="steer">→ Steer <kbd>⌘↵</kbd></button><button class="control-button" data-action="pause">${state.paused ? '▶ 继续' : 'Ⅱ 暂停'}</button><button class="control-button" data-action="stop">■ 停止</button><button class="control-button" data-action="rewind">↶ Rewind <kbd>⌘R</kbd></button><span class="control-meta">12:42 · 45.1k tok · ¥0.84</span></footer>`;
};

const taskView = (view, params) => {
  const activeTab = params.get('tab') ?? (view === 'task-review' ? 'changes' : 'current');
  const config = {
    'task-running': { title: state.paused ? '实现桌面端任务工作台' : '实现桌面端任务工作台', kicker: 'TASK #184 · codex/desktop-shell', stateText: state.paused ? '已暂停' : '执行中 · 等待批准', tone: state.paused ? '' : 'attention', status: state.paused ? 'review' : 'attention', timeline: runningTimeline() },
    'task-review': { title: '增加 Rewind 检查点', kicker: 'TASK #176 · pico/review-rewind', stateText: '等待审阅', tone: '', status: 'review', timeline: reviewTimeline() },
    'task-failed': { title: state.cancelled ? '任务已停止' : '连接项目 MCP Server', kicker: 'TASK #169 · local/main', stateText: state.cancelled ? '用户停止' : '任务被阻塞', tone: 'failed', status: 'failed', timeline: failedTimeline() },
    'task-completed': { title: '整理工具错误信息', kicker: 'TASK #151 · main', stateText: '已完成', tone: 'done', status: 'done', timeline: completedTimeline() },
  }[view] ?? null;
  if (!config) return homeView();

  return `
    <div class="app-shell">${titlebar({ section: 'work', status: state.paused ? '运行已暂停' : '本地运行时已连接' })}
      <div class="work-shell">${globalNav('work')}${taskRail()}
        <main class="task-canvas">${taskHeader(config)}${config.timeline}${view === 'task-running' ? composer() : '<div></div>'}</main>
        ${inspector(view, activeTab)}
        ${controlbar(view)}
      </div>
    </div>`;
};

const homeView = () => `
  <div class="app-shell">${titlebar({ section: 'work' })}
    <div class="work-shell">${globalNav('work')}${taskRail()}
      <main class="home" id="main-content" style="grid-column:3 / 5"><div class="home-inner">
        <div class="home-head"><div><h1>今天要推进什么？</h1><p>pico-harness · 2 个任务需要你处理，2 个任务正在运行。</p></div><button class="primary-button" data-action="new-task">＋ 新建任务</button></div>
        <div class="attention-strip"><strong>需要你处理</strong><p>“实现审批中心的风险分级”正在等待网络与锁文件写入批准。</p><button class="secondary-button" data-action="approval">查看并决定</button></div>
        <div class="work-sections">
          <section class="work-section"><h2>活跃工作</h2><div class="home-task-list">
            <button class="home-task" data-action="select-task" data-task="desktop" data-view="task-running">${statusDot('running')}<span class="home-task-copy"><strong>实现桌面端任务工作台</strong><span>正在运行测试 · 子代理 2/3</span></span><time>12:42</time></button>
            <button class="home-task" data-action="select-task" data-task="review" data-view="task-review">${statusDot('review')}<span class="home-task-copy"><strong>增加 Rewind 检查点</strong><span>6 个文件待审阅 · 7/7 测试通过</span></span><time>14m</time></button>
            <button class="home-task" data-action="select-task" data-task="failed" data-view="task-failed">${statusDot('failed')}<span class="home-task-copy"><strong>连接项目 MCP Server</strong><span>连续失败 3 次，需要恢复</span></span><time>31m</time></button>
          </div></section>
          <section class="work-section"><h2>最近活动</h2><div class="activity-list"><div class="activity"><time>10:26</time><span>任务进入等待批准，系统已发送桌面通知。</span></div><div class="activity"><time>10:24</time><span>子代理完成权限边界审查。</span></div><div class="activity"><time>09:42</time><span>自动化“每日 CI 摘要”运行成功。</span></div><div class="activity"><time>昨天</time><span>整理工具错误信息已合入 main。</span></div></div></section>
        </div>
      </div></main>
    </div>
  </div>`;

const pageShell = (section, body) => `
  <div class="app-shell">${titlebar({ section })}<div class="page-shell">${globalNav(section)}<main class="page" id="main-content"><div class="page-inner">${body}</div></main></div></div>`;

const automationsView = () => pageShell('automations', `
  <header class="page-head"><div class="page-head-copy"><h1>Automations</h1><p>Pico 在本机 daemon 中按计划运行任务；完成或失败时进入通知与审阅队列。</p></div><button class="primary-button" data-action="new-automation">＋ 新建自动化</button></header>
  <div class="page-tabs"><button class="page-tab active">定时任务</button><button class="page-tab">运行记录</button><button class="page-tab">凭证</button></div>
  <div class="table">
    <div class="table-row"><div class="table-main"><strong>每日 CI 失败摘要</strong><span>工作日 09:30 · Asia/Shanghai · pico-harness</span></div><div class="table-cell">下次：明天 09:30</div><div class="table-state">上次成功</div><div class="setting-control"><button class="toggle ${state.automationEnabled ? 'on' : ''}" data-action="toggle-automation" aria-label="启用每日 CI 失败摘要"></button><button class="ghost-button" data-action="automation-detail">查看</button></div></div>
    <div class="table-row"><div class="table-main"><strong>依赖安全检查</strong><span>每周一 08:00 · 网络 allowlist</span></div><div class="table-cell">下次：7 月 20 日</div><div class="table-state paused">已停用</div><div class="setting-control"><button class="toggle" data-action="toggle-generic" aria-label="启用依赖安全检查"></button><button class="ghost-button" data-action="automation-detail">查看</button></div></div>
    <div class="table-row"><div class="table-main"><strong>版本发布简报</strong><span>每周五 17:30 · Provider 凭证缺失</span></div><div class="table-cell">不会运行</div><div class="table-state failed">策略阻止</div><div class="setting-control"><button class="toggle" data-action="toggle-generic" aria-label="启用版本发布简报"></button><button class="ghost-button" data-action="automation-detail">修复</button></div></div>
  </div>`);

const customizeView = (params) => {
  const tab = params.get('tab') ?? 'skills';
  const tabs = `<div class="page-tabs">${['skills', 'mcp', 'plugins'].map((item) => `<button class="page-tab ${tab === item ? 'active' : ''}" data-action="page-tab" data-section="customize" data-tab="${item}">${{ skills: 'Skills', mcp: 'MCP', plugins: 'Plugins' }[item]}</button>`).join('')}</div>`;
  let content = '';
  if (tab === 'mcp') content = `<div class="extension-grid"><div class="extension-row"><span class="extension-mark">GH</span><span class="extension-copy"><strong>GitHub</strong><span>stdio · 18 个工具 · 用户配置</span></span><button class="toggle ${state.mcpEnabled ? 'on' : ''}" data-action="toggle-mcp" aria-label="启用 GitHub MCP"></button></div><div class="extension-row"><span class="extension-mark">LI</span><span class="extension-copy"><strong>Linear</strong><span>需要授权 · OAuth 尚未完成</span></span><button class="secondary-button" data-action="mcp-auth">授权</button></div><div class="extension-row"><span class="extension-mark">FS</span><span class="extension-copy"><strong>Filesystem</strong><span>项目配置 · 仅当前工作区</span></span><button class="toggle on" data-action="toggle-generic" aria-label="启用 Filesystem MCP"></button></div></div>`;
  else if (tab === 'plugins') content = `<div class="notice attention">Plugin 运行时尚未启用。本地登记的插件不会自动向 Agent 暴露能力。</div><div class="extension-grid" style="margin-top:16px"><div class="extension-row"><span class="extension-mark">UI</span><span class="extension-copy"><strong>frontend-toolkit</strong><span>manifest 已发现 · 贡献 3 个 Skills</span></span><button class="secondary-button" data-action="plugin-manifest">审阅</button></div><div class="extension-row"><span class="extension-mark">QA</span><span class="extension-copy"><strong>quality-gates</strong><span>未启用 · 声明 Hooks 与命令</span></span><button class="secondary-button" data-action="plugin-manifest">审阅</button></div></div>`;
  else content = `<div class="extension-grid"><div class="extension-row"><span class="extension-mark">FE</span><span class="extension-copy"><strong>frontend-aesthetic-workflow</strong><span>用户 Skill · 最近使用 8 分钟前</span></span><button class="toggle ${state.skillEnabled ? 'on' : ''}" data-action="toggle-skill" aria-label="启用 frontend aesthetic workflow"></button></div><div class="extension-row"><span class="extension-mark">PW</span><span class="extension-copy"><strong>playwright</strong><span>用户 Skill · 浏览器验证</span></span><button class="toggle on" data-action="toggle-generic" aria-label="启用 Playwright Skill"></button></div><div class="extension-row"><span class="extension-mark">GH</span><span class="extension-copy"><strong>github</strong><span>Plugin Skill · 需要连接 GitHub</span></span><button class="secondary-button" data-action="skill-use">连接</button></div><div class="extension-row"><span class="extension-mark">＋</span><span class="extension-copy"><strong>创建新 Skill</strong><span>从指令、脚本和资源开始</span></span><button class="ghost-button" data-action="skill-use">创建</button></div></div>`;
  return pageShell('customize', `<header class="page-head"><div class="page-head-copy"><h1>扩展</h1><p>管理 Skills、MCP 和未来的 Plugins；项目来源只在 Workspace 信任后加载。</p></div><button class="secondary-button" data-action="reload-extensions">重新扫描</button></header>${tabs}${content}`);
};

const settingsView = (params) => {
  const tab = params.get('tab') ?? 'providers';
  const tabs = `<div class="page-tabs">${['providers', 'permissions', 'usage', 'notifications'].map((item) => `<button class="page-tab ${tab === item ? 'active' : ''}" data-action="page-tab" data-section="settings" data-tab="${item}">${{ providers: 'Providers & Models', permissions: 'Permissions & Trust', usage: 'Usage & Trace', notifications: 'Notifications' }[item]}</button>`).join('')}</div>`;
  let content = '';
  if (tab === 'permissions') content = `<section class="settings-section"><h2>默认交互模式</h2><p>Desktop 默认使用逐次确认；hardline 和 Hook deny 在任何模式都不可绕过。</p><div class="setting-row"><div class="setting-copy"><strong>新任务默认模式</strong><span>影响文件写入、命令和网络访问</span></div><div class="setting-control"><select class="select" aria-label="新任务默认模式"><option>逐次确认（default）</option><option>自动编辑（auto）</option><option>计划模式（plan）</option><option>完全自主（yolo）</option></select></div></div></section><section class="settings-section"><h2>已信任工作区</h2><div class="setting-row"><div class="setting-copy"><strong>~/Code/pico-harness</strong><span>真实路径 · 2026-07-10 信任</span></div><div class="setting-control"><button class="danger-button" data-action="revoke-trust">撤销信任</button></div></div></section><section class="settings-section"><h2>额外授权目录</h2><div class="setting-row"><div class="setting-copy"><strong>~/shared/generated</strong><span>仅当前 Session 可写</span></div><div class="setting-control"><button class="ghost-button" data-action="remove-root">移除</button></div></div></section>`;
  else if (tab === 'usage') content = `<section class="settings-section"><h2>本月 Usage</h2><p>成本状态保留“估算、订阅已包含、部分报告、未知”，不会用 0 代替缺失。</p><div class="metric-grid" style="margin-top:14px"><div class="metric"><span>Provider Calls</span><strong>284</strong></div><div class="metric"><span>Token</span><strong>1.84M</strong></div><div class="metric"><span>估算成本</span><strong>¥42.60</strong></div><div class="metric"><span>数据覆盖</span><strong>91%</strong></div></div></section><section class="settings-section"><h2>Trace</h2><div class="setting-row"><div class="setting-copy"><strong>记录完整 Trace</strong><span>保存模型、工具、子代理和审批 Span</span></div><div class="setting-control"><button class="toggle on" data-action="toggle-generic" aria-label="记录完整 Trace"></button></div></div></section>`;
  else if (tab === 'notifications') content = `<section class="settings-section"><h2>桌面通知</h2><p>锁屏通知只显示任务名和风险摘要，不显示命令、路径或 Prompt。</p>${[['等待批准', true], ['需要你的选择', true], ['任务完成', true], ['普通工具调用', false]].map(([label, on]) => `<div class="setting-row"><div class="setting-copy"><strong>${label}</strong><span>${on ? '点击后深链到对应任务' : '保持静默，只在应用内显示'}</span></div><div class="setting-control"><button class="toggle ${on ? 'on' : ''}" data-action="toggle-generic" aria-label="切换${label}通知"></button></div></div>`).join('')}</section>`;
  else content = `<section class="settings-section"><h2>Providers</h2><p>API Key 只来自环境变量或系统凭证库，界面不回显秘密。</p><div class="table"><div class="table-row"><div class="table-main"><strong>zhipu</strong><span>OpenAI compatible · api.zhipu.example</span></div><div class="table-cell">ZHIPU_API_KEY</div><div class="table-state">已连接</div><button class="ghost-button" data-action="provider-diagnose">诊断</button></div><div class="table-row"><div class="table-main"><strong>anthropic</strong><span>Claude native · api.anthropic.com</span></div><div class="table-cell">系统凭证库</div><div class="table-state">已连接</div><button class="ghost-button" data-action="provider-diagnose">诊断</button></div></div></section><section class="settings-section"><h2>当前模型</h2><div class="setting-row"><div class="setting-copy"><strong>zhipu/glm-5.2</strong><span>131k context · reasoning · tool call</span></div><div class="setting-control"><button class="secondary-button" data-action="model-menu">切换模型</button></div></div><div class="setting-row"><div class="setting-copy"><strong>Vision</strong><span>Provider 未显式声明</span></div><div class="setting-control"><span class="table-state paused">未知</span></div></div></section>`;
  return pageShell('settings', `<header class="page-head"><div class="page-head-copy"><h1>设置</h1><p>配置 Provider、权限、Usage 和通知；运行时决定仍由 Pico 引擎执行。</p></div></header>${tabs}${content}`);
};

const onboardingView = (view) => {
  const stepIndex = { welcome: 0, workspace: 1, trust: 2, provider: 3, scan: 4 }[view] ?? 0;
  const steps = Array.from({ length: 5 }, (_, index) => `<span class="step ${index < stepIndex ? 'done' : index === stepIndex ? 'active' : ''}"></span>`).join('');
  let panel = '';
  if (view === 'workspace') panel = `<h2>选择一个工作区</h2><p>Pico 只会在你明确选择并信任的目录中读取项目配置和会话。</p><div class="choice-list"><button class="choice selected" data-action="select-workspace"><span class="choice-mark">PH</span><span class="choice-copy"><strong>pico-harness</strong><span>~/Code/pico-harness · Git 仓库</span></span><span class="choice-check">✓</span></button><button class="choice" data-action="choose-folder"><span class="choice-mark">＋</span><span class="choice-copy"><strong>选择其他目录…</strong><span>打开系统文件夹选择器</span></span><span>→</span></button></div><div class="onboarding-actions"><button class="ghost-button" data-route="onboarding/welcome">返回</button><button class="primary-button" data-route="onboarding/trust">继续</button></div>`;
  else if (view === 'trust') panel = `<h2>信任 pico-harness？</h2><p>信任后 Pico 才会读取项目指令、Skills、MCP、Hooks 和已有 Session。</p><div class="notice attention" style="margin-top:18px"><code>~/Code/pico-harness</code><br>真实路径：<code>/Users/anxuan/Code/pico-harness</code></div><div class="trust-box"><div class="trust-row"><span class="trust-icon">✓</span><span>允许读取项目文件和 <code>AGENTS.md</code></span></div><div class="trust-row"><span class="trust-icon">✓</span><span>允许加载项目 Skills、MCP 与 Hooks</span></div><div class="trust-row"><span class="trust-icon">!</span><span>文件写入、命令和网络仍按权限模式决定</span></div></div><div class="onboarding-actions"><button class="ghost-button" data-route="onboarding/workspace">返回</button><button class="primary-button" data-route="onboarding/provider">信任并继续</button></div>`;
  else if (view === 'provider') panel = `<h2>连接模型 Provider</h2><p>可以跳过登录直接本地使用。API Key 只进入当前环境或系统凭证库。</p><div class="provider-form"><div class="form-row"><label for="provider">Provider</label><select id="provider" class="select"><option>OpenAI compatible</option><option>Claude native</option></select></div><div class="form-row"><label for="endpoint">API Endpoint</label><input id="endpoint" class="field" type="url" name="endpoint" autocomplete="url" value="https://api.example.com/v1"></div><div class="form-row"><label for="key-source">凭证来源</label><select id="key-source" class="select"><option>环境变量 ZHIPU_API_KEY</option><option>导入系统凭证库…</option></select><div class="form-help">Pico 不会把密钥值写入项目配置或 Session。</div></div></div><div class="onboarding-actions"><button class="ghost-button" data-route="onboarding/trust">返回</button><button class="primary-button" data-route="onboarding/scan">测试连接并继续</button></div>`;
  else if (view === 'scan') panel = `<h2>项目已准备好</h2><p>Pico 完成了只读扫描，没有修改任何文件。</p><div class="trust-box"><div class="trust-row"><span class="trust-icon">✓</span><span>检测到 TypeScript · Node 22 · Git main</span></div><div class="trust-row"><span class="trust-icon">✓</span><span>发现 24 个 Skills、3 个 MCP 配置、12 个 Session</span></div><div class="trust-row"><span class="trust-icon">✓</span><span>Provider zhipu/glm-5.2 连接正常</span></div></div><div class="onboarding-actions"><button class="ghost-button" data-route="onboarding/provider">返回</button><button class="primary-button" data-route="work/home">进入工作台</button></div>`;
  else panel = `<h2>先从本地工作开始</h2><p>Pico 是运行在你电脑上的 Agent 工作台。文件、Git、凭证和执行环境继续留在本机。</p><div class="choice-list"><button class="choice selected" data-route="onboarding/workspace"><span class="choice-mark">⌂</span><span class="choice-copy"><strong>本地使用</strong><span>选择目录并配置自己的 Provider</span></span><span>→</span></button><button class="choice" data-action="login"><span class="choice-mark">◎</span><span class="choice-copy"><strong>登录并同步</strong><span>同步订阅、远程任务与跨设备通知</span></span><span>→</span></button></div><div class="onboarding-actions"><span></span><button class="primary-button" data-route="onboarding/workspace">继续使用本地模式</button></div>`;

  return `<main class="onboarding" id="main-content"><section class="onboarding-brand"><div class="onboarding-logo"><span class="brand-mark">P</span>Pico</div><div class="onboarding-promise"><h1>让 Agent 工作，<br>让每一步可见。</h1><p>在本地项目中运行、监督、审阅和回退 Agent 任务。重要动作始终由你决定。</p></div><div class="onboarding-foot">LOCAL-FIRST · AUDITABLE · REVERSIBLE</div></section><section class="onboarding-main"><div class="onboarding-panel"><div class="stepper">${steps}</div>${panel}</div></section></main>`;
};

const modalShell = ({ title, description, body, actions, size = '', label = title }) => `
  <div class="modal-layer" data-action="modal-backdrop">
    <section class="modal ${size}" role="dialog" aria-modal="true" aria-label="${label}">
      <header class="modal-head"><div class="modal-head-copy"><h2>${title}</h2><p>${description}</p></div><button class="icon-button" data-action="close-dialog" aria-label="关闭">×</button></header>
      <div class="modal-body">${body}</div>
      ${actions ? `<footer class="modal-foot">${actions}</footer>` : ''}
    </section>
  </div>`;

const newTaskModal = () => modalShell({
  title: '新建任务',
  description: '任务绑定当前 Workspace；运行环境、模型与权限在开始前明确确认。',
  size: 'large',
  body: `<div class="form-grid"><div class="form-row span-2"><label for="task-prompt">你希望 Pico 完成什么？</label><textarea id="task-prompt" class="prompt-field" name="task-prompt" autocomplete="off" data-autofocus placeholder="例如：修复 Session 恢复时的状态丢失，并增加一条集成测试…"></textarea><div class="form-help">支持拖入文件、图片或使用 @ 引用项目文件。</div></div><div class="form-row"><label>运行环境</label><div class="segmented"><button class="segment active">当前目录</button><button class="segment">独立 Worktree</button></div></div><div class="form-row"><label for="task-model">模型</label><select id="task-model" class="select"><option>zhipu/glm-5.2</option><option>anthropic/claude-opus</option></select></div><div class="form-row"><label for="task-mode">权限模式</label><select id="task-mode" class="select"><option>逐次确认（推荐）</option><option>自动编辑</option><option>计划模式</option><option>完全自主</option></select></div><div class="form-row"><label for="task-budget">成本预算</label><select id="task-budget" class="select"><option>¥5.00</option><option>¥10.00</option><option>不设置</option></select></div></div><div class="notice" style="margin-top:14px">当前目录有 2 个未提交文件。Pico 会保留来源，不会把它们归因给新任务。</div>`,
  actions: '<button class="ghost-button" data-action="close-dialog">取消</button><button class="primary-button" data-action="preview-plan">生成计划</button>',
});

const planModal = () => modalShell({
  title: '开始前确认计划',
  description: 'Plan 阶段只读取项目，不会修改文件或运行有副作用的命令。',
  size: 'large',
  body: `<div class="notice"><strong>任务目标</strong><br>${escapeHtml(state.draftPrompt)}</div><div class="plan-list" style="margin-top:14px"><div class="plan-line"><span>1</span><span>复现目标行为并保留证据</span><time>只读</time></div><div class="plan-line"><span>2</span><span>定位 Runtime 事件与持久化边界</span><time>只读</time></div><div class="plan-line"><span>3</span><span>实现最小修复并增加集成测试</span><time>写入</time></div><div class="plan-line"><span>4</span><span>运行针对性测试并汇总 Diff</span><time>命令</time></div></div><div class="impact-grid" style="margin-top:16px"><span>环境　<b>当前目录</b></span><span>模型　<b>zhipu/glm-5.2</b></span><span>权限　<b>逐次确认</b></span><span>预算　<b>¥5.00</b></span></div>`,
  actions: '<button class="ghost-button" data-action="back-new-task">返回修改</button><button class="secondary-button" data-action="save-plan">保存 Plan</button><button class="primary-button" data-action="start-task">批准计划并开始</button>',
});

const approvalModal = () => modalShell({
  title: '访问外部网络并修改依赖锁文件',
  description: '命令尚未执行。批准决定会写入任务审计时间线。',
  body: `<div class="notice attention"><div class="command-block">pnpm install --lockfile-only</div><div class="impact-grid"><span>工作目录　<b>pico-harness/</b></span><span>网络目标　<b>registry.npmjs.org</b></span><span>文件影响　<b>pnpm-lock.yaml</b></span><span>回退点　<b>checkpoint-04</b></span><span>规则来源　<b>default/network</b></span><span>风险级别　<b>中</b></span></div></div><div class="radio-list" style="margin-top:13px"><label class="radio-option"><input type="radio" name="approval-scope" checked><span class="radio-copy"><strong>仅运行本次</strong><span>下一次相同命令仍会询问。</span></span></label><label class="radio-option"><input type="radio" name="approval-scope"><span class="radio-copy"><strong>本任务允许 registry.npmjs.org</strong><span>只授权此主机，不包含其他域名或目录。</span></span></label></div>`,
  actions: '<button class="danger-button" data-action="deny-approval">拒绝</button><button class="primary-button" data-action="approve-once">批准并继续</button>',
});

const askModal = () => modalShell({
  title: '需要你的选择',
  description: '这是方案决定，不会授予文件、命令或网络权限。',
  body: `<p class="event-copy" style="margin-bottom:12px">Session 数据应该保存在哪里？</p><div class="radio-list"><label class="radio-option"><input type="radio" name="answer" checked><span class="radio-copy"><strong>当前项目 .pico/</strong><span>随项目移动，不进入 Git。</span></span></label><label class="radio-option"><input type="radio" name="answer"><span class="radio-copy"><strong>用户目录 ~/.pico/</strong><span>可以跨项目共享。</span></span></label><label class="radio-option"><input type="radio" name="answer"><span class="radio-copy"><strong>暂不持久化</strong><span>只在本次运行有效。</span></span></label></div>`,
  actions: '<button class="ghost-button" data-action="cancel-answer">取消问题</button><button class="primary-button" data-action="confirm-answer">确认选择</button>',
});

const rewindModal = () => modalShell({
  title: 'Rewind 预览',
  description: '先选择恢复点和范围。执行前 Pico 会重新校验所有文件指纹。',
  size: 'large',
  body: `<div class="segmented"><button class="segment active">代码和对话</button><button class="segment">仅对话</button><button class="segment">仅代码</button></div><div class="rewind-preview"><div class="checkpoint-list"><button class="checkpoint active">实现桌面端任务工作台<span>10:14 · 5 个文件</span></button><button class="checkpoint">接入审批与子代理<span>10:20 · 3 个文件</span></button><button class="checkpoint">运行针对性验证<span>10:25 · 1 个文件</span></button></div><div><div class="notice attention">恢复代码会覆盖 Pico 在此后的已记录修改。包安装、网络请求、数据库和后台进程不会被撤销。</div><div class="section-title" style="margin-top:12px"><span>将恢复</span><span>5 个文件</span></div><div class="preview-files"><span>M src/desktop/workspace-shell.tsx</span><span>A src/desktop/approval-bridge.ts</span><span>M src/desktop/task-timeline.tsx</span><span>M tests/desktop-flow.test.ts</span></div></div></div>`,
  actions: '<button class="ghost-button" data-action="close-dialog">取消</button><button class="primary-button" data-action="confirm-rewind">校验并 Rewind</button>',
});

const stopModal = () => modalShell({
  title: '停止任务？',
  description: '停止不会自动撤销已经写入的文件。',
  body: '<div class="notice attention">将终止当前模型请求、命令及其子进程，并清空待处理 Steer。你可以稍后通过 Rewind 恢复已记录文件。</div>',
  actions: '<button class="ghost-button" data-action="close-dialog">取消</button><button class="danger-button" data-action="confirm-stop">停止任务</button>',
});

const notificationsModal = () => modalShell({
  title: '通知中心',
  description: '只集中需要行动和重要终态；普通工具调用保持静默。',
  body: `<div class="table"><button class="table-row wide" data-action="approval" style="border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left"><span class="table-main"><strong>需要批准 · 实现审批中心的风险分级</strong><span>网络访问与锁文件写入 · 2 分钟前</span></span><span class="table-state">需要你</span><span></span><span>→</span></button><button class="table-row wide" data-route="work/task-review" style="border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left"><span class="table-main"><strong>任务完成 · 增加 Rewind 检查点</strong><span>6 个文件待审阅 · 14 分钟前</span></span><span class="table-state">待审阅</span><span></span><span>→</span></button><button class="table-row wide" data-route="work/task-failed" style="border:0;background:transparent;text-align:left"><span class="table-main"><strong>任务被阻塞 · 连接项目 MCP Server</strong><span>连续失败 3 次 · 31 分钟前</span></span><span class="table-state failed">失败</span><span></span><span>→</span></button></div>`,
  actions: '<button class="ghost-button" data-action="mark-read">全部已读</button><button class="secondary-button" data-action="close-dialog">关闭</button>',
});

const sessionsModal = () => modalShell({
  title: 'Session 工作库',
  description: '恢复前会重新检查 Workspace 信任、日志健康和模型路由。',
  size: 'large',
  body: `<div class="page-tabs"><button class="page-tab active">活跃</button><button class="page-tab">已归档</button><button class="page-tab">Fork 关系</button></div><div class="table"><button class="table-row wide" data-route="work/task-running" style="border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left"><span class="table-main"><strong>实现桌面端任务工作台</strong><span>pico-harness · 42 条消息 · 健康</span></span><span class="table-cell">今天 10:26</span><span class="table-state">运行中</span><span>打开</span></button><button class="table-row wide" data-route="work/task-review" style="border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left"><span class="table-main"><strong>增加 Rewind 检查点</strong><span>pico-harness · Fork from TASK #162</span></span><span class="table-cell">今天 14:22</span><span class="table-state">待审阅</span><span>打开</span></button><button class="table-row wide" data-route="work/task-completed" style="border:0;background:transparent;text-align:left"><span class="table-main"><strong>整理工具错误信息</strong><span>pico-harness · 18 条消息</span></span><span class="table-cell">昨天</span><span class="table-state">已完成</span><span>打开</span></button></div>`,
  actions: '<button class="secondary-button" data-action="close-dialog">关闭</button>',
});

const commandModal = () => modalShell({
  title: '跳转到…',
  description: '搜索任务、设置或原型中的完整交互状态。',
  body: `<input class="field wide" name="command-search" autocomplete="off" aria-label="搜索命令" data-autofocus placeholder="搜索任务或页面…"><div class="choice-list">${[
    ['工作首页', 'work/home'], ['新建任务', 'work/home?dialog=new-task'], ['运行中任务', 'work/task-running'], ['等待审批', 'work/task-running?dialog=approval'], ['需要回答', 'work/task-running?dialog=ask'], ['待审阅', 'work/task-review'], ['Rewind 预览', 'work/task-review?dialog=rewind'], ['失败恢复', 'work/task-failed'], ['完成摘要', 'work/task-completed'], ['Automations', 'automations'], ['扩展', 'customize'], ['设置', 'settings'], ['首次启动', 'onboarding/welcome'],
  ].map(([label, route]) => `<button class="choice" data-route="${route}"><span class="choice-mark">→</span><span class="choice-copy"><strong>${label}</strong><span>#${route}</span></span><span>↵</span></button>`).join('')}</div>`,
});

const automationModal = () => modalShell({
  title: '新建自动化',
  description: '确认周期、工作区、凭证和网络边界后才会注册到本机 daemon。',
  size: 'large',
  body: `<div class="form-grid"><div class="form-row span-2"><label for="automation-prompt">任务指令</label><textarea id="automation-prompt" class="prompt-field" name="automation-prompt" autocomplete="off" placeholder="每天汇总最新 CI 失败，按影响范围排序并给出修复建议…"></textarea></div><div class="form-row"><label for="schedule">周期</label><input id="schedule" class="field" name="schedule" autocomplete="off" value="工作日 09:30"></div><div class="form-row"><label for="timezone">时区</label><select id="timezone" class="select"><option>Asia/Shanghai</option></select></div><div class="form-row"><label for="automation-model">模型</label><select id="automation-model" class="select"><option>zhipu/glm-5.2</option></select></div><div class="form-row"><label for="network">工具网络</label><select id="network" class="select"><option>allowlist: github.com</option><option>disabled</option></select></div></div><div class="notice attention" style="margin-top:14px">未来三次运行：7 月 15 日 09:30、7 月 16 日 09:30、7 月 17 日 09:30。模型 Provider 网络不受“工具网络”开关影响。</div>`,
  actions: '<button class="ghost-button" data-action="close-dialog">取消</button><button class="secondary-button" data-action="automation-draft">保存为停用草案</button><button class="primary-button" data-action="create-automation">确认并创建</button>',
});

const genericInfoModal = (kind) => {
  const data = {
    tool: ['工具详情', '完整参数、输出顺序和 Trace ID', '<div class="kv-list"><div class="kv"><span>Tool Call ID</span><code>call_7F2A9</code></div><div class="kv"><span>工作目录</span><strong>pico-harness/</strong></div><div class="kv"><span>耗时</span><strong>12.04s</strong></div><div class="kv"><span>退出码</span><strong>running</strong></div><div class="kv"><span>Trace ID</span><code>span_8B12</code></div></div><div class="command-block" style="margin-top:12px">pnpm vitest run tests/integration/desktop-flow.test.ts\n\n✓ 5 tests passed\n◌ desktop shell renders approval state…</div>'],
    agent: ['子代理详情 · Rewind 数据流', '独立上下文与工具输出不会混入主任务时间线。', '<div class="kv-list"><div class="kv"><span>模式</span><strong>explore · required</strong></div><div class="kv"><span>当前动作</span><strong>验证指纹冲突保护</strong></div><div class="kv"><span>进度</span><strong>58%</strong></div><div class="kv"><span>Token</span><strong>6.1k</strong></div><div class="kv"><span>Worktree</span><code>只读</code></div></div><div class="trace-list" style="margin-top:14px"><div class="trace-row"><span>10:16</span><span>读取 rewind coordinator</span><strong>ok</strong></div><div class="trace-row"><span>10:18</span><span>检查冲突分支</span><strong>ok</strong></div><div class="trace-row"><span>10:20</span><span>汇总发现</span><strong>running</strong></div></div>'],
    workspace: ['切换 Workspace', '正在运行的任务仍绑定原 Workspace。', '<div class="choice-list"><button class="choice selected" data-action="close-dialog"><span class="choice-mark">PH</span><span class="choice-copy"><strong>pico-harness</strong><span>7 个任务 · 当前</span></span><span>✓</span></button><button class="choice" data-action="close-dialog"><span class="choice-mark">AH</span><span class="choice-copy"><strong>agent-harness-course</strong><span>2 个任务</span></span><span>→</span></button><button class="choice" data-route="onboarding/workspace"><span class="choice-mark">＋</span><span class="choice-copy"><strong>添加 Workspace</strong><span>选择并建立新的信任记录</span></span><span>→</span></button></div>'],
  }[kind] ?? ['详情', '原型状态说明', '<div class="notice">此交互已经纳入完整状态机。</div>'];
  return modalShell({ title: data[0], description: data[1], body: data[2], actions: '<button class="secondary-button" data-action="close-dialog">关闭</button>' });
};

const dialogFor = (name) => {
  const dialogs = {
    'new-task': newTaskModal,
    plan: planModal,
    approval: approvalModal,
    ask: askModal,
    rewind: rewindModal,
    stop: stopModal,
    notifications: notificationsModal,
    sessions: sessionsModal,
    command: commandModal,
    'new-automation': automationModal,
    tool: () => genericInfoModal('tool'),
    agent: () => genericInfoModal('agent'),
    workspace: () => genericInfoModal('workspace'),
  };
  return dialogs[name]?.() ?? '';
};

const render = () => {
  const { section, view, params } = parseRoute();
  let html = '';
  if (section === 'onboarding') html = onboardingView(view);
  else if (section === 'automations') html = automationsView();
  else if (section === 'customize') html = customizeView(params);
  else if (section === 'settings') html = settingsView(params);
  else html = view === 'home' ? homeView() : taskView(view, params);

  const dialog = params.get('dialog');
  app.innerHTML = `${html}${dialog ? dialogFor(dialog) : ''}`;
  if (dialog) requestAnimationFrame(() => app.querySelector('[data-autofocus], .modal button')?.focus());
};

const closeDialog = () => updateRouteParams({ dialog: null });

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-route], [data-action]');
  if (!target) return;

  const route = target.dataset.route;
  if (route) {
    const [path, query = ''] = route.split('?');
    routeTo(path, Object.fromEntries(new URLSearchParams(query)));
    return;
  }

  const action = target.dataset.action;
  const handlers = {
    'new-task': () => updateRouteParams({ dialog: 'new-task' }),
    'preview-plan': () => {
      const prompt = app.querySelector('#task-prompt')?.value.trim();
      if (!prompt) return showToast('请先输入任务目标');
      state.draftPrompt = prompt;
      updateRouteParams({ dialog: 'plan' });
    },
    'back-new-task': () => updateRouteParams({ dialog: 'new-task' }),
    'save-plan': () => showToast('Plan 已保存到当前任务草案'),
    'start-task': () => { state.selectedTask = 'desktop'; routeTo('work/task-running'); showToast('任务已开始 · 当前目录 · 逐次确认'); },
    approval: () => updateRouteParams({ dialog: 'approval' }),
    'approve-once': () => { closeDialog(); showToast('已批准本次命令 · 决定已写入审计时间线'); },
    'deny-approval': () => { closeDialog(); showToast('已拒绝操作 · Pico 将调整执行方案'); },
    'cancel-answer': () => { closeDialog(); showToast('已取消问题 · Agent 收到 cancelled'); },
    'confirm-answer': () => {
      const answer = app.querySelector('input[name="answer"]:checked')?.closest('label')?.querySelector('strong')?.textContent;
      closeDialog();
      showToast(`选择已发送 · ${answer ?? '已记录回答'}`);
    },
    'close-dialog': closeDialog,
    'modal-backdrop': () => { if (event.target === target) closeDialog(); },
    command: () => updateRouteParams({ dialog: 'command' }),
    notifications: () => updateRouteParams({ dialog: 'notifications' }),
    sessions: () => updateRouteParams({ dialog: 'sessions' }),
    'workspace-menu': () => updateRouteParams({ dialog: 'workspace' }),
    'tool-detail': () => updateRouteParams({ dialog: 'tool' }),
    'agent-detail': () => updateRouteParams({ dialog: 'agent' }),
    'select-task': () => {
      state.selectedTask = target.dataset.task;
      routeTo(`work/${target.dataset.view}`, target.dataset.dialog ? { dialog: target.dataset.dialog } : {});
    },
    'inspector-tab': () => updateRouteParams({ tab: target.dataset.tab }),
    'select-file': () => { state.selectedFile = target.dataset.file; render(); },
    rewind: () => updateRouteParams({ dialog: 'rewind' }),
    'confirm-rewind': () => { closeDialog(); showToast('指纹校验通过 · 已恢复代码和对话 · 原指令已回填'); },
    stop: () => updateRouteParams({ dialog: 'stop' }),
    'confirm-stop': () => { state.cancelled = true; state.selectedTask = 'failed'; routeTo('work/task-failed'); showToast('任务已安全停止 · 文件变化保留'); },
    pause: () => { state.paused = !state.paused; render(); showToast(state.paused ? '已在安全边界暂停 · 现场与队列已保留' : '任务已继续运行'); },
    steer: () => app.querySelector('.composer textarea')?.focus(),
    send: () => { const input = app.querySelector('.composer textarea'); if (!input?.value.trim()) return showToast('请输入要补充的方向'); input.value = ''; showToast('Steer 已加入 · 将在下一模型边界生效'); },
    'request-changes': () => { state.selectedTask = 'desktop'; routeTo('work/task-running'); showToast('修改要求已加入下一轮'); },
    'complete-review': () => { state.selectedTask = 'done'; routeTo('work/task-completed'); showToast('应用预检通过 · 变更已合入目标分支'); },
    retry: () => { state.selectedTask = 'desktop'; routeTo('work/task-running'); showToast('已从失败步骤创建新的安全重试'); },
    'open-settings': () => routeTo('settings', { tab: 'providers' }),
    'open-editor': () => showToast('将在外部编辑器中打开当前文件'),
    'export-trace': () => showToast('Trace 导出已准备：.claw/traces/trace-7F2A.json'),
    archive: () => showToast('任务已归档 · Session、Trace 与 Usage 仍然保留'),
    'new-automation': () => updateRouteParams({ dialog: 'new-automation' }),
    'create-automation': () => { closeDialog(); showToast('自动化已创建并启用 · 下次明天 09:30'); },
    'automation-draft': () => { closeDialog(); showToast('已保存为停用草案'); },
    'toggle-automation': () => { state.automationEnabled = !state.automationEnabled; render(); showToast(state.automationEnabled ? '自动化已启用' : '自动化已停用'); },
    'toggle-skill': () => { state.skillEnabled = !state.skillEnabled; render(); },
    'toggle-mcp': () => { state.mcpEnabled = !state.mcpEnabled; render(); },
    'toggle-generic': () => { target.classList.toggle('on'); showToast(target.classList.contains('on') ? '已启用' : '已停用'); },
    'page-tab': () => routeTo(target.dataset.section, { tab: target.dataset.tab }),
    'reload-extensions': () => showToast('扩展已重新扫描 · 24 Skills · 3 MCP'),
    'mcp-auth': () => showToast('已打开安全授权流程 · Token 不会回显'),
    'plugin-manifest': () => showToast('已打开 manifest 审阅 · Runtime 仍保持禁用'),
    'skill-use': () => showToast('已准备在新任务中使用此扩展'),
    'provider-diagnose': () => showToast('连接正常 · 模型发现 4 个 · 218ms'),
    'model-menu': () => showToast('运行中模型将在本轮结束后才能切换'),
    'permission-menu': () => routeTo('settings', { tab: 'permissions' }),
    'revoke-trust': () => showToast('正在运行的任务必须先停止，才能撤销 Workspace 信任'),
    'remove-root': () => showToast('额外授权目录已从本 Session 移除'),
    'mark-read': () => { closeDialog(); showToast('通知已全部标记为已读'); },
    login: () => showToast('登录是可选能力，本地使用无需登录'),
    'choose-folder': () => showToast('原生 App 将在此处打开系统文件夹选择器'),
    'select-workspace': () => {},
    'task-filter': () => showToast('筛选：状态、项目、环境、时间'),
    density: () => showToast('Transcript 密度：摘要 → 标准 → 详细'),
    'input-mode': () => showToast('输入模式：Steer、排到下一轮、替换当前任务'),
    'automation-detail': () => showToast('已打开自动化详情与运行记录'),
  };
  handlers[action]?.();
});

document.addEventListener('keydown', (event) => {
  const modifier = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    updateRouteParams({ dialog: 'command' });
  }
  if (modifier && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    updateRouteParams({ dialog: 'new-task' });
  }
  if (event.key === 'Tab' && parseRoute().params.get('dialog')) {
    const focusable = [...app.querySelectorAll('.modal button:not([disabled]), .modal input:not([disabled]), .modal select:not([disabled]), .modal textarea:not([disabled]), .modal [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  if (event.key === 'Escape' && parseRoute().params.get('dialog')) closeDialog();
});

window.addEventListener('hashchange', render);
render();
