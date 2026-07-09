import { describe, expect, it } from "vitest";
import { shouldStartTuiByDefault } from "../src/cli/launch-mode.js";

describe("CLI launch mode", () => {
  it("starts TUI when no one-shot prompt or positional task is provided", () => {
    expect(
      shouldStartTuiByDefault({
        tui: false,
        prompt: undefined,
        positionals: [],
      }),
    ).toBe(true);
  });

  it("starts TUI even when a prompt or positional task is provided", () => {
    expect(
      shouldStartTuiByDefault({
        tui: false,
        prompt: "/status",
        positionals: [],
      }),
    ).toBe(true);
    expect(
      shouldStartTuiByDefault({
        tui: false,
        prompt: undefined,
        positionals: ["read README"],
      }),
    ).toBe(true);
  });

  it("respects explicit --tui", () => {
    expect(
      shouldStartTuiByDefault({
        tui: true,
        prompt: "ignored",
        positionals: ["ignored"],
      }),
    ).toBe(true);
  });
});
