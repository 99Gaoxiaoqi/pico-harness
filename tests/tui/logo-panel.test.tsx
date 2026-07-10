import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { LogoPanel } from "../../src/tui/logo-panel.js";

describe("LogoPanel", () => {
  it("renders pico, model, cwd, mode, permission, MCP, and task as the session launch transcript item", () => {
    const output = renderToString(
      <LogoPanel
        model="glm-5.2"
        cwd="/workspace/demo"
        sessionMode="plan"
        permissionMode="auto"
        mcpSummary="2 MCP"
        taskSummary="修复 TUI"
      />,
    );

    expect(output).toContain("pico");
    expect(output).toContain("glm-5.2");
    expect(output).toContain("/workspace/demo");
    expect(output).toContain("mode plan");
    expect(output).toContain("perm auto");
    expect(output).toContain("2 MCP");
    expect(output).toContain("修复 TUI");
  });

  it("truncates long cwd values in the middle", () => {
    const longCwd = "/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness";
    const output = renderToString(<LogoPanel model="glm-5.2" cwd={longCwd} cwdMaxLength={28} />);

    expect(output).toContain("/Users/anxu...");
    expect(output).toContain("pico-harness");
    expect(output).not.toContain(longCwd);
  });

  it("falls back to compact defaults without runtime props", () => {
    const output = renderToString(<LogoPanel />);

    expect(output).toContain("pico · Agent Harness");
  });
});
