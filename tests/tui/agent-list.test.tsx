import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { AGENT_DESCRIPTION_WIDTH, AgentList, formatAgentRows } from "../../src/tui/agent-list.js";
import type { ClaudeAgentSummary } from "../../src/input/agent-loader.js";

describe("AgentList", () => {
  it("renders an empty state", () => {
    expect(renderToString(<AgentList agents={[]} />)).toContain("No agents available");
    expect(formatAgentRows([])).toEqual([]);
  });

  it("renders source tags and tools", () => {
    const agents: ClaudeAgentSummary[] = [
      {
        description: "Review code",
        name: "reviewer",
        source: "project",
        sourcePath: "/tmp/reviewer.md",
        tools: ["Read", "Grep"],
      },
      {
        description: "Search and understand the codebase",
        name: "Explore",
        source: "builtin",
        sourcePath: "builtin:Explore",
        tools: ["Read", "Grep", "Glob"],
      },
    ];

    const output = renderToString(<AgentList agents={agents} />);

    expect(output).toContain("[project]");
    expect(output).toContain("[built-in]");
    expect(output).toContain("tools: Read, Grep");
    expect(output).toContain("tools: Read, Grep, Glob");
  });

  it("truncates long descriptions for stable rows", () => {
    const agents: ClaudeAgentSummary[] = [
      {
        description:
          "This description is intentionally long enough to overflow the compact agent list row.",
        name: "long-agent",
        source: "project",
        sourcePath: "/tmp/long-agent.md",
      },
    ];

    const rows = formatAgentRows(agents);
    const output = renderToString(<AgentList agents={agents} />);

    expect(rows[0]?.description.length).toBeLessThanOrEqual(AGENT_DESCRIPTION_WIDTH);
    expect(rows[0]?.description).toContain("...");
    expect(output).toContain("This description is intentionally long enough");
    expect(output).not.toContain("compact agent list row");
  });
});
