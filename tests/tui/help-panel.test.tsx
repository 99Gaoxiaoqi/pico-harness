import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import {
  HelpPanel,
  formatHelpPanel,
  formatHelpPanelSections,
  updateHelpPanelScroll,
  type HelpPanelCommand,
} from "../../src/tui/help-panel.js";

describe("HelpPanel", () => {
  it("groups commands by source and kind with aliases, args, and descriptions", () => {
    const commands: HelpPanelCommand[] = [
      {
        name: "help",
        aliases: ["h", "?"],
        argumentHint: "[command]",
        description: "Show available slash commands",
        kind: "local",
        source: "builtin",
      },
      {
        name: "review",
        aliases: ["rv"],
        argumentHint: "<path>",
        description: "Review changed files",
        kind: "prompt",
        source: "project",
      },
      {
        name: "theme",
        description: "Open theme picker",
        kind: "local-jsx",
        source: "plugin",
      },
    ];

    const sections = formatHelpPanelSections(commands);
    const output = formatHelpPanel(commands, { selectedIndex: 1 });

    expect(sections.map((section) => section.title)).toEqual([
      "builtin / local",
      "project / prompt",
      "plugin / local-jsx",
    ]);
    expect(output).toContain("Slash commands");
    expect(output).toContain("  /help [command]  Show available slash commands");
    expect(output).toContain("    aliases: /h, /?");
    expect(output).toContain("› /review <path>  Review changed files");
    expect(output).toContain("    aliases: /rv");
    expect(output).toContain("  /theme  Open theme picker");
  });

  it("renders as a compact Ink component", () => {
    const output = renderToString(
      <HelpPanel
        commands={[
          {
            name: "model",
            argumentHint: "[name]",
            description: "Show or change the active model",
            kind: "local",
            source: "builtin",
          },
          {
            name: "mcp",
            description: "Show MCP server connection status",
            kind: "local",
            source: "builtin",
          },
        ]}
      />,
    );

    expect(output).toContain("Slash commands");
    expect(output).toContain("builtin / local");
    expect(output).toContain("/model [name]");
    expect(output).toContain("/mcp");
    expect(output).toContain("Show MCP server connection status");
  });

  it("uses scroll props to show a stable command window", () => {
    const commands: HelpPanelCommand[] = [
      command("help"),
      command("status"),
      command("model"),
      command("tools"),
    ];

    const output = formatHelpPanel(commands, {
      selectedIndex: 2,
      scrollOffset: 1,
      maxItems: 2,
    });

    expect(output).toContain("↑ 1 hidden");
    expect(output).toContain("› /model");
    expect(output).toContain("  /status");
    expect(output).not.toContain("/help");
    expect(output).not.toContain("/tools");
    expect(output).toContain("↓ 1 hidden");
  });

  it("clamps selected index and keeps it visible when moving", () => {
    expect(
      updateHelpPanelScroll(
        { selectedIndex: 0, scrollOffset: 0 },
        { delta: 3, totalItems: 5, pageSize: 3 },
      ),
    ).toEqual({ selectedIndex: 3, scrollOffset: 1 });

    expect(
      updateHelpPanelScroll(
        { selectedIndex: 3, scrollOffset: 1 },
        { delta: -5, totalItems: 5, pageSize: 3 },
      ),
    ).toEqual({ selectedIndex: 0, scrollOffset: 0 });
  });

  it("returns an empty state for no commands", () => {
    expect(formatHelpPanel([])).toBe("Slash commands\nNo slash commands available.");
    expect(
      updateHelpPanelScroll(
        { selectedIndex: 4, scrollOffset: 2 },
        { delta: 1, totalItems: 0, pageSize: 3 },
      ),
    ).toEqual({
      selectedIndex: 0,
      scrollOffset: 0,
    });
  });
});

function command(name: string): HelpPanelCommand {
  return {
    name,
    description: `${name} command`,
    kind: "local",
    source: "builtin",
  };
}
