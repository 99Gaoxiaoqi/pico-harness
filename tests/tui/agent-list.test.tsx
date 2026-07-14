import React from "react";
import { renderToString } from "ink";
import { describe, expect, it } from "vitest";
import { AGENT_DESCRIPTION_WIDTH, AgentList, formatAgentRows } from "../../src/tui/agent-list.js";
import type { AgentProfileSummary } from "../../src/agents/catalog.js";

describe("AgentList", () => {
  it("renders an empty state", () => {
    expect(renderToString(<AgentList agents={[]} />)).toContain("No agents available");
    expect(formatAgentRows([])).toEqual([]);
  });

  it("renders source tags and tools", () => {
    const agents: AgentProfileSummary[] = [
      {
        description: "Review code",
        name: "reviewer",
        source: "project-claude",
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

    expect(output).toContain("[project/claude]");
    expect(output).toContain("[built-in]");
    expect(output).toContain("tools: Read, Grep");
    expect(output).toContain("tools: Read, Grep, Glob");
  });

  it("truncates long descriptions for stable rows", () => {
    const agents: AgentProfileSummary[] = [
      {
        description:
          "This description is intentionally long enough to overflow the compact agent list row.",
        name: "long-agent",
        source: "project-claude",
        sourcePath: "/tmp/long-agent.md",
        tools: [],
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
