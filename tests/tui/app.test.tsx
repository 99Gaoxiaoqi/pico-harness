import React from "react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render, renderToString, Text, type Instance } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  commandSuggestions,
  createPicoCommandRegistry,
} from "../../src/input/pico-command-registry.js";
import { createLocalUiDialogRequest } from "../../src/tui/local-ui-dialog-host.js";
import {
  App,
  nextTranscriptScroll,
  resolveAppKeyEvent,
  resolveToolCardToggleKey,
  resolveTranscriptScrollKey,
} from "../../src/tui/app.js";
import { InteractiveApprovalPanel } from "../../src/tui/approval-panel.js";
import { createMainAgentItem, type AgentNavigationItem } from "../../src/tui/agent-navigation.js";

describe("App", () => {
  it("将子代理收进底部导航，并用下键、回车和 Esc 切换详情", async () => {
    const onRedraw = vi.fn();
    const agents: AgentNavigationItem[] = [
      createMainAgentItem({ status: "running" }),
      {
        id: "activity-engine",
        kind: "subagent",
        status: "running",
        agentName: "engine-agent",
        task: "检查引擎主循环",
        mode: "explore",
        currentAction: "DETAIL_ONLY_ACTION",
        timeline: [
          { id: "trace-thinking", kind: "thinking" },
          {
            id: "trace-tool",
            kind: "tool",
            name: "read_file",
            status: "completed",
            summary: "src/engine/loop.ts",
          },
        ],
      },
    ];
    const app = (
      <App
        model="glm-5.2"
        workDir="/workspace/demo"
        entries={[
          { kind: "assistant", content: "主代理仍在这里" },
          {
            kind: "subagent-activity",
            task: "检查引擎主循环",
            status: "running",
            currentAction: "DETAIL_ONLY_ACTION",
          },
        ]}
        agents={agents}
        running
        keybindings={{ Global: { tab: "app:redraw" } }}
        onRedraw={onRedraw}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app);

    try {
      let output = await harness.rerender(app);
      expect(output).toContain("主代理仍在这里");
      expect(output).toContain("Agents · 1");
      expect(output).toContain("engine-agent  检查引擎主循环");
      expect(output).not.toContain("DETAIL_ONLY_ACTION");

      await harness.write("\t");
      expect(onRedraw).toHaveBeenCalledOnce();
      await harness.write("\u001b[B");
      output = await harness.write("\r");
      expect(output).toContain("← Main / engine-agent");
      expect(output).toContain("DETAIL_ONLY_ACTION");
      expect(output).toContain("Read File");
      expect(output).toContain("Viewing subagent · Esc back to Main");

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      output = await harness.rerender(app);
      expect(output).toContain("主代理仍在这里");
      expect(output).not.toContain("DETAIL_ONLY_ACTION");

      // 24 行终端中 switcher 占最后 3 行：标题、Main、子代理。
      await harness.write("\u001b[<0;5;24M");
      output = await harness.write("\r");
      expect(output).toContain("← Main / engine-agent");
    } finally {
      await harness.cleanup();
    }
  });

  it("renders history messages separately from the single bottom input box", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[
          { kind: "user", content: "你好" },
          { kind: "assistant", content: "你好！" },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("你好");
    expect(output).toContain("你好！");
    expect(countOccurrences(output, "pico · glm-5.2 · provider openai · /workspace/demo")).toBe(1);
    expect(output).toContain("phase idle");
    expect(output).toContain("mode new");
    expect(output).toContain("perm yolo");
    expect(output).not.toContain("glm-5.2/openai");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(1);
    expect(countOccurrences(output, "Enter 发送")).toBe(0);
    expect(countOccurrences(output, "Tab 补全")).toBe(0);
  });

  it("keeps the bottom input active while running so new prompts can queue", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[{ kind: "assistant", content: "处理中" }]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("处理中");
    expect(output).not.toContain("Running…");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(1);
    expect(countOccurrences(output, "Enter 发送")).toBe(0);
  });

  it("uses the real content width for transcript layout on an extremely narrow terminal", async () => {
    const app = (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/工作区/从0开始构建AgentHarness/pico-harness"
        sessionMode="plan"
        permissionMode="auto"
        mcpSummary="MCP 1/2"
        taskSummary="真实任务"
        entries={[
          {
            kind: "error",
            message: "错误包含中文和 emoji 🚀，需要和布局测高一致",
            retryable: false,
          },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app, { columns: 12, rows: 24 });

    try {
      const output = await harness.rerender(app);

      expect(output.split("\n").length).toBeLessThanOrEqual(24);
      expect(output).toContain("Try");
      expect(output).toContain("phase");
      expect(output).not.toContain("真实任务");
      expect(output).not.toContain("MCP 1/2");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps full registry slash candidates through InputBox and completes beyond the first window", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-app-registry-suggestions-"));
    const commandsDir = join(workDir, ".pico", "commands");
    mkdirSync(commandsDir, { recursive: true });
    for (let i = 0; i < 24; i++) {
      writeFileSync(
        join(commandsDir, `bulk-${String(i).padStart(2, "0")}.md`),
        `---\ndescription: bulk ${i}\n---\n\nBulk ${i}`,
      );
    }
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir={workDir}
        entries={[]}
        running={false}
        slashCommandSuggestions={(query) => commandSuggestions(registry, query)}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("/bulk");
      await harness.write("\u001b[B".repeat(20));
      const output = await harness.write("\t");

      expect(output).toContain("/bulk-20");
    } finally {
      await harness.cleanup();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("awaits async argument completers and discards stale query results", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-app-async-completer-"));
    const submitted = vi.fn();
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir={workDir}
        entries={[]}
        running={false}
        slashArgumentSuggestions={
          (async (command, query) => {
            await new Promise((resolve) => setTimeout(resolve, query === "k" ? 30 : 1));
            if (command !== "model") return [];
            return query === "k"
              ? [{ value: "kube-stale", description: "stale result" }]
              : [{ value: "kimi-k2.5", description: "fresh result" }];
          }) as never
        }
        onSubmit={submitted}
      />,
    );

    try {
      await harness.write("/model k");
      await harness.write("i");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const output = await harness.rerender(
        <App
          model="glm-5.2"
          provider="openai"
          workDir={workDir}
          entries={[]}
          running={false}
          slashArgumentSuggestions={
            (async (command) =>
              command === "model"
                ? [{ value: "kimi-k2.5", description: "fresh result" }]
                : []) as never
          }
          onSubmit={submitted}
        />,
      );

      expect(output).toContain("kimi-k2.5");
      expect(output).not.toContain("kube-stale");
    } finally {
      await harness.cleanup();
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("calls an async suggestion source once per input state and catches rejected results", async () => {
    const calls: string[] = [];
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[]}
        running={false}
        slashCommandSuggestions={(query) => {
          calls.push(query);
          return query === "h"
            ? Promise.reject(new Error("late failure"))
            : Promise.resolve([{ value: "help", description: "Show help" }]);
        }}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("/");
      await harness.write("h");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(calls).toEqual(["", "h"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not render spinner while assistant text is streaming", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[{ kind: "assistant", content: "正在输出" }]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("正在输出");
    expect(output).not.toContain("生成回复中");
  });

  it("renders the focused modal and disables the bottom input while modal is active", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[{ kind: "user", content: "打开设置" }]}
        running={false}
        dialogRequests={[
          { id: "tips", layer: "overlay", priority: 10, content: <Text>Overlay tips</Text> },
          { id: "settings", layer: "modal", priority: 50, content: <Text>Settings modal</Text> },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("打开设置");
    expect(output).toContain("Settings modal");
    expect(output).not.toContain("Overlay tips");
    expect(output).toContain("Use dialog controls");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(0);
  });

  it("keeps help focused, scrollable, and closable without letting InputBox steal keys", async () => {
    const closeDialog = vi.fn();
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands: ["help", "status", "model", "tools", "mcp", "exit"].map((name) => ({
        name,
        description: `${name} command`,
        kind: "local" as const,
        source: "builtin" as const,
        category: name === "help" ? ("help" as const) : ("system" as const),
      })),
      onClose: closeDialog,
      maxHelpItems: 3,
    } as never);
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[]}
        running={false}
        dialogRequests={request ? [request] : []}
        onSubmit={vi.fn()}
      />,
      { columns: 80, rows: 16 },
    );

    try {
      let output = await harness.write("abc");
      expect(output).not.toContain("abc▋");

      output = await harness.write("\u001b[B");
      expect(output).toContain("Use dialog controls");
      expect(output).toContain("› /status");

      output = await harness.write("\u001b[6~");
      expect(output).toContain("› /mcp");

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");
    } finally {
      await harness.cleanup();
    }
  });

  it("budgets production help overlay to the visible window on a 24 row terminal", async () => {
    const closeDialog = vi.fn();
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands: Array.from({ length: 18 }, (_, index) => ({
        name: `cmd-${String(index).padStart(2, "0")}`,
        description: `command ${index}`,
        kind: "local" as const,
        source: "builtin" as const,
        category: "system" as const,
      })),
      onClose: closeDialog,
    } as never);
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running={false}
        dialogRequests={request ? [request] : []}
        onSubmit={vi.fn()}
      />,
      { columns: 80, rows: 24 },
    );

    try {
      const output = await harness.write("\u001b[6~");
      expect(output).toContain("› /cmd-11");
      expect(output).toContain("Use dialog controls");
      expect(output).not.toContain('Try "fix this" or / for commands');
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");
    } finally {
      await harness.cleanup();
    }
  });

  it("sizes real registry help dynamically and restores input after Esc", async () => {
    const closeDialog = vi.fn();
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "app-help-dynamic-idle",
    });
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands: registry.list({ includeDisabled: true, availabilityState: "idle" }),
      onClose: closeDialog,
    } as never);
    const entries = Array.from({ length: 20 }, (_, index) => ({
      kind: "assistant" as const,
      content: `message-${index}`,
    }));
    const app = (dialogRequests = request ? [request] : []) => (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={entries}
        running={false}
        dialogRequests={dialogRequests}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app(), { columns: 80, rows: 24 });

    try {
      let output = await harness.write("\u001b[B");
      expect(output).toContain("builtin / help");
      expect(output).toContain("aliases: /h, /?");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      let foundPermissions = false;
      for (let page = 0; page < 12; page += 1) {
        output = await harness.write("\u001b[6~");
        expect(output.split("\n").length).toBeLessThanOrEqual(24);
        if (output.includes("builtin / permissions")) {
          foundPermissions = true;
          break;
        }
      }
      expect(foundPermissions).toBe(true);
      expect(output).toContain("builtin / permissions");
      expect(output).toContain("aliases: /permission");
      expect(output).toContain("/permissions [default|auto|yolo|plan]");

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");

      output = await harness.rerender(app([]));
      output = await harness.write("after");
      expect(output).toContain("after▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps real running help scrollable with disabled reasons and wrapped rows", async () => {
    const closeDialog = vi.fn();
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "app-help-dynamic-running",
    });
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands: registry.list({ includeDisabled: true, availabilityState: "running" }),
      onClose: closeDialog,
    } as never);
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running
        dialogRequests={request ? [request] : []}
        onSubmit={vi.fn()}
      />,
      { columns: 80, rows: 24 },
    );

    try {
      let output = await harness.write("\u001b[6~");
      expect(output).toContain("[disabled]");
      expect(output).toContain("Command is only available while idle.");
      expect(output).toContain("↓");
      expect(countOccurrences(output, "[disabled]")).toBe(countOccurrences(output, "[disabled]  "));
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      output = await harness.write("\u001b[6~");
      expect(output).toContain("›");
      expect(output).toContain("Use dialog controls");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps every CJK and emoji help page within a 60x24 terminal", async () => {
    const closeDialog = vi.fn();
    const commands = Array.from({ length: 18 }, (_, index) => ({
      name: `多语言-${String(index).padStart(2, "0")}`,
      aliases: [`别名-${index}`, `emoji-${index}`],
      usage: `/多语言-${String(index).padStart(2, "0")} [选项|参数|更长的参数名]`,
      description: `处理中文宽字符、组合 emoji 👨‍👩‍👧‍👦、状态 ${index}，并展示一段足够长的说明文字用于真实换行测量`,
      kind: "local" as const,
      source: "builtin" as const,
      category: index % 2 === 0 ? ("system" as const) : ("workspace" as const),
      disabled: index % 3 === 0,
      disabledReason:
        index % 3 === 0
          ? "运行中不可用：请等待当前任务结束后再执行这个包含中文和 emoji 🚦 的命令。"
          : undefined,
    }));
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands,
      onClose: closeDialog,
    } as never);
    const app = (dialogRequests = request ? [request] : []) => (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running={false}
        dialogRequests={dialogRequests}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app(), { columns: 60, rows: 24 });

    try {
      let output = await harness.write("\u001b[6~");
      expect(output).toContain("Use dialog controls");
      expect(output).toContain("↓");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      output = await harness.write("\u001b[6~");
      expect(output).toContain("›");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      output = await harness.write("\u001b[6~");
      expect(output).toContain("Slash commands");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");

      output = await harness.rerender(app([]));
      output = await harness.write("恢复");
      expect(output).toContain("恢复▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("budgets the worst help page on a 26x24 terminal", async () => {
    const closeDialog = vi.fn();
    const commands = [
      {
        name: "短",
        usage: "/短",
        description: "短",
        kind: "local" as const,
        source: "builtin" as const,
        category: "system" as const,
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        name: `复杂-${index}`,
        aliases: [`别名-${index}`, `长别名-${index}`],
        usage: `/复杂-${index} [中文参数|emoji🚦]`,
        description: `后续页面 ${index} 包含中文宽字符、emoji 👨‍👩‍👧‍👦、类别、别名和禁用原因，需要用真实视觉高度预算`,
        kind: "local" as const,
        source: "builtin" as const,
        category: index % 2 === 0 ? ("workspace" as const) : ("system" as const),
        disabled: true,
        disabledReason: `禁用原因 ${index}：运行中不可用，请等待当前任务结束后再执行 🚦。`,
      })),
    ];
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands,
      onClose: closeDialog,
    } as never);
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running={false}
        dialogRequests={request ? [request] : []}
        onSubmit={vi.fn()}
      />,
      { columns: 26, rows: 24 },
    );

    try {
      const output = await harness.write("\u001b[6~");

      expect(output).toContain("Slash commands");
      expect(output).toContain("↑");
      expect(output).toContain("↓");
      expect(output).toContain("Use dialog controls");
      expect(output).toContain("────────────────");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");
    } finally {
      await harness.cleanup();
    }
  });

  it("clips a single oversized help command without covering chrome on a 26x24 terminal", async () => {
    const closeDialog = vi.fn();
    const request = createLocalUiDialogRequest({ kind: "open-panel", panel: "help" }, {
      commands: [
        {
          name: "超长命令🚦",
          aliases: Array.from({ length: 24 }, (_, index) => `别名-${index}-👨‍👩‍👧‍👦-非常长`),
          usage: "/超长命令🚦 [中文参数|emoji👨‍👩‍👧‍👦|extra-long-option-name]",
          description:
            "这是一个单项就很高的命令说明，包含大量中文宽字符和 emoji 👨‍👩‍👧‍👦，如果不在命令详情内部裁剪就会覆盖标题、footer、status 和输入区域。",
          kind: "local" as const,
          source: "builtin" as const,
          category: "workspace" as const,
          disabled: true,
          disabledReason:
            "禁用原因：当前运行状态不允许执行这个命令。这里故意放入很多中文宽字符、emoji 🚦🚦🚦 和额外说明，验证单项详情内部必须裁剪。",
        },
      ],
      onClose: closeDialog,
    } as never);
    const app = (dialogRequests = request ? [request] : []) => (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running={false}
        dialogRequests={dialogRequests}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app(), { columns: 26, rows: 24 });

    try {
      let output = await harness.write("\u001b[B");

      expect(output).toContain("Slash commands");
      expect(output).toContain("› /超长命令");
      expect(output).toContain("[disabled]");
      expect(output).toContain("aliases:");
      expect(output).toContain("…");
      expect(output).toContain("Use dialog controls");
      expect(output).toContain("────────────────");
      expect(output.split("\n").length).toBeLessThanOrEqual(24);

      await harness.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(closeDialog).toHaveBeenCalledWith("local-ui:help");

      output = await harness.rerender(app([]));
      output = await harness.write("恢复");
      expect(output).toContain("恢复▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("renders approval as an inline modal and disables the bottom input", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[
          { kind: "user", content: "更新文件" },
          { kind: "tool", name: "write_file", args: '{"path":"AIHOT.md"}', status: "approval" },
        ]}
        running
        dialogRequests={[
          {
            id: "approval:pending:approval-1",
            layer: "modal",
            priority: 80,
            content: <Text>Approval required: write_file</Text>,
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("Approval required: write_file");
    expect(output).toContain("Use dialog controls");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(0);
    expect(output).not.toContain("┌");
  });

  it("keeps model/cwd in the logo and runtime state in the status bar", () => {
    const output = renderToString(
      <App
        model="claude-sonnet"
        modelRouteId="anthropic/claude-sonnet"
        provider="claude"
        workDir="/workspace/demo"
        sessionMode="resume"
        permissionMode="acceptEdits"
        thinkingEffort="high"
        mcpSummary="MCP"
        taskSummary="task"
        entries={[]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("pico · anthropic/claude-sonnet · provider claude · think high");
    expect(output).toContain("/workspace");
    expect(output).toContain("/demo");
    expect(output).toContain("MCP");
    expect(output).toContain("task");
    expect(output).toContain("phase idle");
    expect(output).toContain("mode resume");
    expect(output).toContain("perm acceptEdits");
    expect(output).toContain("task task");
    expect(output).not.toContain("ctx claude");
    expect(output).toContain("provider claude");
    expect(output).toContain("think high");
  });

  it("maps global Ctrl shortcuts to interrupt, exit, and redraw semantics", () => {
    expect(resolveAppKeyEvent("c", { ctrl: true }, false)).toBeNull();
    expect(resolveAppKeyEvent("c", { ctrl: true }, true)).toBe("interrupt");
    expect(resolveAppKeyEvent("d", { ctrl: true }, true)).toBe("exit");
    expect(resolveAppKeyEvent("l", { ctrl: true }, false)).toBe("redraw");
  });

  it("Enter 只由聚焦的审批面板消费并批准一次", async () => {
    const onAction = vi.fn();
    const onSubmit = vi.fn();
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "write_file",
            args: '{"path":"approved.txt"}',
            status: "approval",
          },
        ]}
        running
        dialogRequests={[
          {
            id: "approval:pending:approval-enter",
            layer: "modal",
            priority: 80,
            content: (
              <InteractiveApprovalPanel
                taskId="approval-enter"
                toolName="write_file"
                args={JSON.stringify({ path: "approved.txt", content: "ok" })}
                message="approval"
                onAction={onAction}
              />
            ),
          },
        ]}
        onSubmit={onSubmit}
      />,
    );

    try {
      await harness.write("\r");
      await harness.write("\r");
      expect(onAction).toHaveBeenCalledOnce();
      expect(onAction).toHaveBeenCalledWith("approve");
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it("applies configured global bindings and null unbinds", () => {
    const keybindings = {
      Global: {
        "ctrl+x": "app:exit" as const,
        "ctrl+d": null,
      },
    };

    expect(resolveAppKeyEvent("x", { ctrl: true }, false, keybindings)).toBe("exit");
    expect(resolveAppKeyEvent("d", { ctrl: true }, false, keybindings)).toBeNull();
  });

  it("renders the bottom transcript window for long conversations", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 60 }, (_, i) => ({
          kind: "assistant" as const,
          content: `message-${i}`,
        }))}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("message-59");
    expect(output).not.toContain("message-0");
  });

  it("renders the tail of a long streaming assistant response", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          { kind: "assistant", content: "old context" },
          {
            kind: "assistant",
            content: Array.from({ length: 40 }, (_, i) => `tail-line-${i}`).join("\n"),
          },
        ]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("tail-line-39");
    expect(output).not.toContain("tail-line-0");
  });

  it("computes transcript page scrolling around the bottom anchor", () => {
    expect(nextTranscriptScroll(null, "pageUp", 10, 100)).toBe(82);
    expect(nextTranscriptScroll(82, "pageDown", 10, 100)).toBe(null);
    expect(nextTranscriptScroll(5, "top", 10, 100)).toBe(0);
    expect(nextTranscriptScroll(5, "bottom", 10, 100)).toBeNull();
  });

  it("keeps plain arrows on input and reserves modified arrows for transcript scrolling", () => {
    expect(resolveTranscriptScrollKey({ upArrow: true })).toBeNull();
    expect(resolveTranscriptScrollKey({ downArrow: true })).toBeNull();
    expect(resolveTranscriptScrollKey({ ctrl: true, upArrow: true })).toBe("lineUp");
    expect(resolveTranscriptScrollKey({ ctrl: true, downArrow: true })).toBe("lineDown");
  });

  it("modal focus blocks transcript and ToolCard shortcuts", () => {
    expect(resolveTranscriptScrollKey({ pageUp: true }, true)).toBeNull();
    expect(resolveToolCardToggleKey("e", {}, true, false)).toBeNull();
    expect(resolveToolCardToggleKey("e", { ctrl: true }, true, false)).toBe("toggle");
    expect(resolveToolCardToggleKey("e", { ctrl: true }, true, true)).toBeNull();
  });

  it("applies configured transcript bindings", () => {
    const keybindings = {
      Transcript: {
        "ctrl+t": "transcript:toggleShowAll" as const,
        "ctrl+e": null,
      },
    };

    expect(resolveToolCardToggleKey("t", { ctrl: true }, true, false, keybindings)).toBe("toggle");
    expect(resolveToolCardToggleKey("e", { ctrl: true }, true, false, keybindings)).toBeNull();
  });

  it("Ctrl+E expands and scrolls to the latest ToolCard above a long assistant reply", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "read_file",
            args: '{"path":"README.md"}',
            status: "success",
            summary: "result-line-0\nresult-line-1",
          },
          {
            kind: "assistant",
            content: Array.from({ length: 40 }, (_, index) => `tail-line-${index}`).join("\n"),
          },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
      { columns: 80, rows: 24 },
    );

    try {
      const frame = await harness.write("\u0005");

      expect(frame).toContain("result-line-1");
      expect(frame).toContain("tail-line-0");
      expect(frame).not.toContain("tail-line-39");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps a bound Chat shortcut on a non-empty draft instead of expanding ToolCard", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "read_file",
            args: '{"path":"README.md"}',
            status: "success",
            summary: "result-line-0\nresult-line-1",
          },
          { kind: "assistant", content: "finished" },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("ab");
      await harness.write("\u001b[D");
      const frame = await harness.write("\u0005");

      expect(frame).toContain("ab▋");
      expect(frame).not.toContain("参数");
      expect(frame).not.toContain("result-line-1");
    } finally {
      await harness.cleanup();
    }
  });

  it("Ctrl+E expands the latest running ToolCard while a turn is active", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "bash",
            args: '{"command":"npm test"}',
            status: "running",
            summary: "still running",
          },
          { kind: "thinking" },
        ]}
        running
        onSubmit={vi.fn()}
      />,
    );

    try {
      const frame = await harness.write("\u0005");

      expect(frame).toContain("参数");
      expect(frame).toContain("command:npm test");
      expect(frame).toContain("Running");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps Ctrl+E and plain e in the input when no ToolCard shortcut owns them", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("ab");
      await harness.write("\u001b[D");
      let frame = await harness.write("\u0005");
      expect(frame).toContain("ab▋");

      frame = await harness.write("e");
      expect(frame).toContain("abe▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not let a modal leak Ctrl+E to the latest ToolCard", async () => {
    const entries = [
      {
        kind: "tool" as const,
        name: "read_file",
        args: '{"path":"README.md"}',
        status: "success" as const,
        summary: "result-line-0\nresult-line-1",
      },
      { kind: "assistant" as const, content: "finished" },
    ];
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={entries}
        running={false}
        dialogRequests={[
          { id: "settings", layer: "modal", priority: 50, content: <Text>Settings modal</Text> },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    try {
      expect(await harness.write("\u0005")).toBe("");
      const frame = await harness.rerender(
        <App
          model="glm-5.2"
          provider="openai"
          workDir="/workspace/demo"
          entries={entries}
          running={false}
          onSubmit={vi.fn()}
        />,
      );

      expect(frame).toContain("finished");
      expect(frame).not.toContain("参数");
      expect(frame).not.toContain("result-line-1");
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the configured ToolCard shortcut for a tool followed by system feedback", async () => {
    const keybindings = {
      Transcript: {
        "ctrl+t": "transcript:toggleShowAll" as const,
        "ctrl+e": null,
      },
    };
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "read_file",
            args: '{"path":"README.md"}',
            status: "success",
            summary: "result-line-0\nresult-line-1",
          },
          { kind: "system", content: "local feedback" },
        ]}
        running={false}
        keybindings={keybindings}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("ab");
      await harness.write("\u001b[D");
      let frame = await harness.write("\u0005");
      expect(frame).not.toContain("参数");
      expect(frame).toContain("ab▋");

      frame = await harness.write("\u0014");
      expect(frame).toContain("参数");
      expect(frame).toContain("result-line-1");
      expect(frame).toContain("local feedback");
      expect(frame).toContain("ab▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not let plain e steal the prompt when a ToolCard is available", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "read_file",
            args: '{"path":"README.md"}',
            status: "success",
            summary: "done",
          },
          { kind: "assistant", content: "finished" },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    try {
      const frame = await harness.write("e");

      expect(frame).toContain("e▋");
      expect(frame).not.toContain("参数");
    } finally {
      await harness.cleanup();
    }
  });

  it("running Up stays with input history instead of scrolling the transcript", async () => {
    const onSubmit = vi.fn();
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 30 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running
        onSubmit={onSubmit}
      />,
    );

    try {
      await harness.write("first\r");
      expect(onSubmit).toHaveBeenCalledWith({ text: "first", attachments: [] });
      await harness.write("draft");
      const frame = await harness.write("\u001b[A");

      expect(frame).toContain("first▋");
      expect(frame).not.toContain("draft▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("counts new messages while away from bottom and clears the count on return", async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      kind: "assistant" as const,
      content: `message-${index}`,
    }));
    const app = (nextEntries: typeof entries) => (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={nextEntries}
        running={false}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app(entries));

    try {
      await harness.write("\u001b[5~");
      const withNewMessages = await harness.rerender(
        app([
          ...entries,
          { kind: "assistant", content: "new-1" },
          { kind: "assistant", content: "new-2" },
        ]),
      );
      expect(withNewMessages).toContain("2 new messages");

      const atBottom = await harness.write("\u001b[1;5F");
      expect(atBottom).not.toContain("2 new messages");
    } finally {
      await harness.cleanup();
    }
  });

  it("reflows a narrow transcript when approval diff is toggled with E", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 20 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running
        dialogRequests={[
          {
            id: "approval:pending:approval-1",
            layer: "modal",
            priority: 80,
            content: (
              <InteractiveApprovalPanel
                taskId="approval-1"
                toolName="write_file"
                args={JSON.stringify({ path: `docs/${"nested/".repeat(8)}PLAN.md` })}
                message="Review a long write operation before allowing it to continue"
                diff={Array.from({ length: 6 }, (_, index) => `+added-${index}`).join("\n")}
                onAction={vi.fn()}
              />
            ),
          },
        ]}
        onSubmit={vi.fn()}
      />,
      { columns: 48, rows: 40 },
    );

    try {
      const initiallyExpanded = await harness.rerender(
        <App
          model="glm-5.2"
          provider="openai"
          workDir="/workspace/demo"
          entries={Array.from({ length: 20 }, (_, index) => ({
            kind: "assistant" as const,
            content: `message-${index}`,
          }))}
          running
          dialogRequests={[
            {
              id: "approval:pending:approval-1",
              layer: "modal",
              priority: 80,
              content: (
                <InteractiveApprovalPanel
                  taskId="approval-1"
                  toolName="write_file"
                  args={JSON.stringify({ path: `docs/${"nested/".repeat(8)}PLAN.md` })}
                  message="Review a long write operation before allowing it to continue"
                  diff={Array.from({ length: 6 }, (_, index) => `+added-${index}`).join("\n")}
                  onAction={vi.fn()}
                />
              ),
            },
          ]}
          onSubmit={vi.fn()}
        />,
      );
      expect(initiallyExpanded).toContain("Diff preview:");

      const collapsed = await harness.write("e");
      expect(collapsed).toContain("Diff: +6 -0");
      expect(collapsed).not.toContain("Diff preview:");

      const expandedAgain = await harness.write("e");

      expect(expandedAgain).toContain("Diff preview:");
      expect(expandedAgain).toContain("+added-5");
      expect(expandedAgain).toContain("Use dialog controls");
    } finally {
      await harness.cleanup();
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function createInteractiveApp(
  node: React.ReactNode,
  dimensions: { columns: number; rows: number } = { columns: 80, rows: 24 },
): {
  write: (input: string) => Promise<string>;
  rerender: (node: React.ReactNode) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, {
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: dimensions.columns, writable: true },
    rows: { value: dimensions.rows, writable: true },
  });
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async rerender(nextNode: React.ReactNode): Promise<string> {
      const offset = output.length;
      instance.rerender(nextNode);
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
