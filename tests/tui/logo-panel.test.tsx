import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { LogoPanel } from "../../src/tui/logo-panel.js";

describe("LogoPanel", () => {
  it("renders pico, model, and cwd as the first-screen launch signal", () => {
    const output = renderToString(<LogoPanel model="glm-5.2" cwd="/workspace/demo" />);

    expect(output).toContain("pico");
    expect(output).toContain("glm-5.2");
    expect(output).toContain("/workspace/demo");
    expect(output).toContain("pico · glm-5.2 · /workspace/demo");
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
