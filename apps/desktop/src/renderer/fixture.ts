import type { AppData } from "./model.js";

const now = Date.now();

export const previewData: AppData = {
  workspacePath: "/Users/chen/Projects/atlas-notes",
  workspaceMode: "git",
  workspaceCapabilities: {
    foregroundRuns: true,
    fileHistory: true,
    isolatedWorktrees: true,
    branchMerge: true,
  },
  trusted: true,
  sessions: [
    {
      id: "session-atlas",
      title: "修复同步冲突并补充回归测试",
      status: "active",
      updatedAt: now - 90_000,
      summary: "正在检查离线队列与云端版本的合并边界。",
    },
    {
      id: "session-editor",
      title: "重构编辑器快捷键",
      status: "active",
      updatedAt: now - 86_400_000,
      summary: "统一 macOS 与 Windows 的按键映射。",
    },
    {
      id: "session-export",
      title: "导出模块性能排查",
      status: "archived",
      updatedAt: now - 518_400_000,
    },
  ],
  runs: [
    {
      id: "run-atlas",
      sessionId: "session-atlas",
      description: "修复同步冲突，并为关键失败路径补一条集成测试",
      status: "running",
      startedAt: now - 428_000,
      updatedAt: now - 8_000,
    },
  ],
  timeline: [
    {
      id: "tl-plan",
      kind: "plan",
      title: "计划已确认",
      detail: "复现冲突 · 收窄写入边界 · 增加集成验证",
      state: "done",
      at: now - 412_000,
      sessionId: "session-atlas",
      runId: "run-atlas",
    },
    {
      id: "tl-agent",
      kind: "agent",
      title: "子代理正在检查存储契约",
      detail: "已定位 3 个调用点，未发现 Schema 变更。",
      state: "active",
      at: now - 242_000,
      sessionId: "session-atlas",
      runId: "run-atlas",
    },
    {
      id: "tl-tool",
      kind: "tool",
      title: "准备运行集成测试",
      detail: "npm test -- sync-conflict.integration.test.ts",
      state: "waiting",
      at: now - 12_000,
      sessionId: "session-atlas",
      runId: "run-atlas",
    },
  ],
  conversations: {
    "session-atlas": {
      sessionId: "session-atlas",
      revision: "preview.1",
      queuedCount: 0,
      settings: {
        modelRouteId: "openai/gpt-5.4",
        model: "gpt-5.4",
        mode: "default",
        thinkingEffort: "high",
        reasoningLevels: ["off", "low", "medium", "high"],
      },
      items: [
        {
          id: "preview-user",
          kind: "userMessage",
          text: "修复同步冲突，并为关键失败路径补一条集成测试。",
          at: now - 428_000,
        },
        {
          id: "preview-boundary",
          kind: "runBoundary",
          status: "started",
          label: "Pico 开始处理",
          at: now - 427_000,
        },
        {
          id: "preview-assistant",
          kind: "assistantMessage",
          text: "我会先复现冲突，再收窄写入边界并补充回归验证。",
          at: now - 410_000,
        },
      ],
    },
  },
  approvals: [
    {
      id: "approval-test",
      runId: "run-atlas",
      title: "允许执行测试命令？",
      detail: "命令只会读取项目文件，并在本地临时目录写入测试产物。",
      command: "npm test -- sync-conflict.integration.test.ts",
      risk: "low",
    },
  ],
  prompts: [
    {
      id: "prompt-strategy",
      runId: "run-atlas",
      question: "冲突时优先保留哪一侧的标题？",
      options: ["保留本地最近编辑", "保留云端版本", "逐项询问"],
    },
  ],
  changes: [
    {
      path: "src/sync/conflict-resolver.ts",
      status: "modified",
      additions: 24,
      deletions: 9,
      patch:
        "@@ -42,9 +42,17 @@\n- return remote;\n+ const newest = local.updatedAt > remote.updatedAt ? local : remote;\n+ return mergeDocument(newest, {\n+   blocks: mergeBlocks(local.blocks, remote.blocks),\n+ });",
    },
    {
      path: "tests/sync-conflict.integration.test.ts",
      status: "added",
      additions: 61,
      deletions: 0,
      patch:
        '@@ -0,0 +1,8 @@\n+describe("sync conflict", () => {\n+  it("keeps the most recent title", async () => {\n+    const result = await resolveFixture();\n+    expect(result.title).toBe("Local draft");\n+  });\n+});',
    },
  ],
  changeFingerprint: "preview:54b9c2",
  jobs: [
    {
      id: "job-deps",
      name: "每周依赖健康检查",
      prompt: "检查高危依赖与过期的直接依赖，给出可执行建议。",
      schedule: "每周一 09:30",
      enabled: true,
      status: "succeeded",
      updatedAt: now - 172_800_000,
    },
    {
      id: "job-release",
      name: "发布说明草稿",
      prompt: "根据本周提交生成面向用户的发布说明。",
      schedule: "每周五 17:00",
      enabled: false,
      status: "idle",
      updatedAt: now - 604_800_000,
    },
  ],
  skills: [
    {
      id: "skill-review",
      name: "代码审查",
      description: "聚焦正确性、安全边界与回归风险。",
      state: "ready",
      meta: "内置",
    },
    {
      id: "skill-docs",
      name: "文档维护",
      description: "让技术说明与当前实现保持一致。",
      state: "ready",
      meta: "工作区",
    },
  ],
  mcpServers: [
    {
      id: "mcp-files",
      name: "Local tools",
      description: "项目文件与本地命令能力。",
      state: "ready",
      meta: "8 个工具",
    },
    {
      id: "mcp-figma",
      name: "Figma",
      description: "读取设计上下文与组件变量。",
      state: "attention",
      meta: "需要登录",
    },
  ],
  providers: [
    {
      id: "provider-openai",
      name: "OpenAI",
      description: "用于任务规划、代码生成与审查。",
      state: "ready",
      meta: "gpt-5.4",
    },
    {
      id: "provider-local",
      name: "本地模型",
      description: "在设备上运行，不发送项目内容。",
      state: "disabled",
      meta: "未配置",
    },
  ],
  providerConfig: {
    supported: true,
    revision: "preview-provider-revision",
    defaultModelRouteId: "openai/gpt-5.4",
    userDefaults: {
      modelRouteId: "openai/gpt-5.4",
      mode: "default",
      thinkingEffort: "high",
    },
    providers: [
      {
        id: "openai",
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        models: ["gpt-5.4", "gpt-5.4-mini"],
        discoverModels: true,
        origin: "user",
        fingerprint: "preview-openai-fingerprint",
        credentialStatus: "ready",
        credentialSource: "keychain",
      },
      {
        id: "local",
        protocol: "openai",
        baseURL: "http://127.0.0.1:11434/v1",
        apiKeyEnv: "LOCAL_LLM_API_KEY",
        models: ["qwen3-coder"],
        discoverModels: false,
        origin: "project-legacy",
        fingerprint: "preview-local-fingerprint",
        credentialStatus: "missing",
        credentialSource: "none",
      },
    ],
  },
  modelRoutes: [
    { id: "openai/gpt-5.4", label: "gpt-5.4" },
    { id: "openai/gpt-5.4-mini", label: "gpt-5.4 mini" },
  ],
  catalogAgents: [
    {
      name: "explore",
      description: "只读探索代码库并返回聚焦结论。",
      source: "builtin",
      tools: ["read_file", "grep", "glob"],
    },
  ],
  catalogSkills: [
    {
      name: "code-review",
      description: "审查正确性、安全边界和回归风险。",
      allowedTools: ["read_file", "grep"],
    },
  ],
  usage: {
    inputTokens: 128_400,
    outputTokens: 22_760,
    cachedTokens: 68_120,
    cost: 3.84,
    period: "本月",
  },
  configVersion: 3,
  launchAtLogin: true,
  notices: {},
};
