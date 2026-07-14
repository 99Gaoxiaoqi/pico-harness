// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopApp } from "./App.js";

afterEach(() => {
  cleanup();
  delete (window as unknown as { pico?: unknown }).pico;
  window.history.replaceState({}, "", "/");
});

describe("DesktopApp renderer", () => {
  it("shows an honest unavailable state when the desktop bridge is missing", async () => {
    window.history.replaceState({}, "", "/#/sessions");
    render(<DesktopApp />);

    expect(
      await screen.findByRole("heading", { name: "界面已就绪，但没有可用的数据连接" }),
    ).toBeTruthy();
    expect(screen.getByText(/不会使用演示数据代替真实任务/)).toBeTruthy();
    expect(screen.queryByText("修复同步冲突并补充回归测试")).toBeNull();
  });

  it("resolves approval and Ask User interactions only inside explicit preview mode", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?demo=1#/task/run-atlas");
    render(<DesktopApp />);

    expect(await screen.findByText("Preview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看审批" }));
    expect(screen.getByRole("dialog", { name: "允许执行测试命令？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "仅允许这次" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "允许执行测试命令？" })).toBeNull(),
    );

    await user.click(screen.getByRole("button", { name: "回答问题" }));
    expect(screen.getByRole("dialog", { name: "冲突时优先保留哪一侧的标题？" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "保留本地最近编辑" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "冲突时优先保留哪一侧的标题？" })).toBeNull(),
    );
  });

  it("moves focus through sidebar navigation with arrow keys", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?demo=1#/");
    render(<DesktopApp />);

    const home = await screen.findByRole("link", { name: "开始" });
    const sessions = screen.getByRole("link", { name: "会话" });
    home.focus();
    expect(document.activeElement).toBe(home);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(sessions);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "设置" }));
  });
});
