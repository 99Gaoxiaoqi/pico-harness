import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { StatusBar, buildStatusItems } from "../../src/tui/status-bar.js";

describe("StatusBar", () => {
  it("renders compact runtime status with session, permission, and thinking effort", () => {
    const output = renderToString(
      <StatusBar
        model="glm-5.2"
        provider="openai"
        cwd="/workspace/demo"
        sessionMode="resume"
        permissionMode="acceptEdits"
        thinkingEffort="high"
      />,
    );

    expect(output).toContain("glm-5.2");
    expect(output).toContain("openai");
    expect(output).toContain("mode resume");
    expect(output).toContain("perm acceptEdits");
    expect(output).toContain("think high");
  });

  it("keeps status item order stable for scanning", () => {
    expect(
      buildStatusItems({
        model: "claude-3-5-sonnet",
        provider: "anthropic",
        cwd: "/repo",
        sessionMode: "new",
        permissionMode: "ask",
        thinkingEffort: "medium",
      }),
    ).toEqual([
      ["model", "claude-3-5-sonnet"],
      ["provider", "anthropic"],
      ["cwd", "/repo"],
      ["mode", "new"],
      ["perm", "ask"],
      ["think", "medium"],
    ]);
  });

  it("falls back cleanly when provider is missing", () => {
    const output = renderToString(
      <StatusBar model="glm-5.2" cwd="/workspace/demo" sessionMode="new" />,
    );

    expect(output).toContain("provider auto");
    expect(output).toContain("mode new");
    expect(output).toContain("perm ask");
    expect(output).toContain("think off");
  });

  it("truncates long cwd values in the middle", () => {
    const longCwd = "/Users/anxuan/geektime-downloader/从0开始构建AgentHarness/pico-harness";
    const output = renderToString(
      <StatusBar model="glm-5.2" cwd={longCwd} sessionMode="continue" cwdMaxLength={30} />,
    );

    expect(output).toContain("/Users/anxua...");
    expect(output).toContain("pico-harness");
    expect(output).not.toContain(longCwd);
  });
});
