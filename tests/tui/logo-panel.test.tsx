import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { LogoPanel } from "../../src/tui/logo-panel.js";

describe("LogoPanel", () => {
  it("renders a compact pico launch mark", () => {
    const output = renderToString(<LogoPanel />);

    expect(output).toContain("pico");
    expect(output).toContain("Agent Harness");
  });

  it("keeps launch branding separate from runtime status", () => {
    const output = renderToString(<LogoPanel />);

    expect(output).not.toContain("model:");
    expect(output).not.toContain("provider:");
    expect(output).not.toContain("cwd:");
    expect(output).not.toContain("session:");
  });
});
