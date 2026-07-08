import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { StatusBar, buildStatusItems } from "../../src/tui/status-bar.js";

describe("StatusBar", () => {
  it("renders model, provider, cwd, and session mode", () => {
    const output = renderToString(
      <StatusBar
        model="glm-5.2"
        provider="openai"
        cwd="/workspace/demo"
        sessionMode="resume"
      />,
    );

    expect(output).toContain("model: glm-5.2");
    expect(output).toContain("provider: openai");
    expect(output).toContain("cwd: /workspace/demo");
    expect(output).toContain("session: resume");
  });

  it("keeps status item order stable for snapshots and scanning", () => {
    expect(
      buildStatusItems({
        model: "claude-3-5-sonnet",
        provider: "anthropic",
        cwd: "/repo",
        sessionMode: "new",
      }),
    ).toEqual([
      ["model", "claude-3-5-sonnet"],
      ["provider", "anthropic"],
      ["cwd", "/repo"],
      ["session", "new"],
    ]);
  });
});
