// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationComposer } from "./ConversationComposer.js";
import { ConversationInspector } from "./ConversationInspector.js";
import { ConversationTranscript } from "./ConversationTranscript.js";
import type { ComposerBehavior, ConversationItemView } from "./types.js";

afterEach(cleanup);

const transcript: readonly ConversationItemView[] = [
  { id: "user-1", kind: "userMessage", text: "检查登录失败的原因" },
  { id: "run-1", kind: "runBoundary", status: "started", label: "第一轮" },
  {
    id: "plan-1",
    kind: "plan",
    steps: [
      { id: "step-1", title: "定位登录入口", state: "done" },
      { id: "step-2", title: "复现失败路径", state: "active" },
    ],
  },
  {
    id: "tool-1",
    kind: "tool",
    toolName: "shell",
    title: "运行登录测试",
    state: "done",
  },
  {
    id: "agent-1",
    kind: "subagent",
    name: "Tesla",
    title: "检查认证模块",
    state: "active",
  },
  {
    id: "status-1",
    kind: "status",
    title: "测试已通过",
    detail: "认证回归路径正常",
    tone: "success",
  },
  {
    id: "assistant-1",
    kind: "assistantMessage",
    text: "问题来自过期的访问令牌。",
    truncated: true,
    originalBytes: 1_200_000,
  },
];

describe("Conversation components", () => {
  it("renders a continuous, semantic transcript and exposes inspectable items", async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    render(<ConversationTranscript items={transcript} onOpenItem={onOpenItem} />);

    expect(screen.getByRole("list", { name: "会话记录" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "你" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Pico" })).toBeTruthy();
    expect(screen.getByText("复现失败路径")).toBeTruthy();
    expect(screen.getByText("测试已通过")).toBeTruthy();
    expect(screen.getByText("问题来自过期的访问令牌。")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("1,200,000 字节");

    await user.click(screen.getByRole("button", { name: "查看 Tesla 的会话" }));
    expect(onOpenItem).toHaveBeenCalledWith(transcript[4]);
  });

  it("uses one composer for idle send and running steer, queue, or replace", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    function Harness() {
      const [value, setValue] = useState("");
      const [behavior, setBehavior] = useState<ComposerBehavior>("steer");
      return (
        <ConversationComposer
          value={value}
          onValueChange={setValue}
          onSubmit={onSubmit}
          status="running"
          behavior={behavior}
          onBehaviorChange={setBehavior}
          onPause={vi.fn()}
          onStop={vi.fn()}
        />
      );
    }

    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "消息" });
    await user.type(textbox, "先不要改协议");
    await user.selectOptions(screen.getByRole("combobox", { name: "运行中消息行为" }), "queue");
    await user.click(textbox);
    await user.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledWith({ text: "先不要改协议", behavior: "queue" });
    expect(screen.getByRole("button", { name: "暂停运行" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "停止运行" })).toBeTruthy();
  });

  it("keeps a newline on Shift+Enter and ignores blank messages", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ConversationComposer
          value={value}
          onValueChange={setValue}
          onSubmit={onSubmit}
          status="idle"
        />
      );
    }

    render(<Harness />);
    const textbox = screen.getByRole("textbox", { name: "消息" });
    await user.type(textbox, "第一行{Shift>}{Enter}{/Shift}第二行");
    expect((textbox as HTMLTextAreaElement).value).toBe("第一行\n第二行");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith({ text: "第一行\n第二行", behavior: "auto" });
    onSubmit.mockClear();

    await user.clear(textbox);
    await user.type(textbox, "   ");
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exposes resume and stop controls while paused", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    const onStop = vi.fn();
    render(
      <ConversationComposer
        value=""
        onValueChange={vi.fn()}
        onSubmit={vi.fn()}
        status="paused"
        onBehaviorChange={vi.fn()}
        onResume={onResume}
        onStop={onStop}
      />,
    );

    await user.click(screen.getByRole("button", { name: "继续运行" }));
    await user.click(screen.getByRole("button", { name: "停止运行" }));
    expect(onResume).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("已暂停");
  });

  it("closes a non-modal inspector with Escape and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开详情
          </button>
          <ConversationInspector
            open={open}
            title="工具详情"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <p>完整输出</p>
          </ConversationInspector>
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开详情" });
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭详情" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });
});
