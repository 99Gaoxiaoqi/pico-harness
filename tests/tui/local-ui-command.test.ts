import { describe, expect, it } from "vitest";
import { hasLocalUiCommandAction, isLocalUiCommandAction } from "../../src/tui/local-ui-command.js";
import type { LocalCommandResult } from "../../src/input/types.js";

describe("local UI command contract", () => {
  it("keeps legacy local command results valid without UI actions", () => {
    const result: LocalCommandResult = {
      type: "local",
      action: "help",
      message: "Available slash commands",
    };

    expect(hasLocalUiCommandAction(result)).toBe(false);
  });

  it("recognizes open-panel UI actions on local command results", () => {
    const result: LocalCommandResult = {
      type: "local",
      action: "help",
      ui: { kind: "open-panel", panel: "help" },
    };

    expect(hasLocalUiCommandAction(result)).toBe(true);
    if (hasLocalUiCommandAction(result)) {
      expect(result.ui.kind).toBe("open-panel");
    }
    if (hasLocalUiCommandAction(result) && result.ui.kind === "open-panel") {
      expect(result.ui.panel).toBe("help");
    }
  });

  it("recognizes open-selector UI actions", () => {
    expect(isLocalUiCommandAction({ kind: "open-selector", selector: "model" })).toBe(true);
    expect(isLocalUiCommandAction({ kind: "open-selector", selector: "unknown" })).toBe(false);
  });
});
