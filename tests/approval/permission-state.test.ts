import { describe, expect, it } from "vitest";
import { createPermissionState } from "../../src/approval/permission-state.js";

describe("permission state", () => {
  it("groups allow, ask, and deny rules from a rules object", () => {
    const state = createPermissionState({
      mode: "ask",
      rules: {
        allow: ["read_file:*", { tool: "bash", pattern: "git status", source: "session" }],
        ask: [{ tool: "write_file", pattern: ".env", reason: "sensitive file" }],
        deny: [{ tool: "bash", pattern: "rm -rf /", reason: "hardline" }],
      },
    });

    expect(state.mode).toBe("ask");
    expect(state.rules.allow).toMatchObject([
      { decision: "allow", label: "read_file:*" },
      { decision: "allow", tool: "bash", pattern: "git status", source: "session" },
    ]);
    expect(state.rules.ask).toMatchObject([
      { decision: "ask", tool: "write_file", pattern: ".env", reason: "sensitive file" },
    ]);
    expect(state.rules.deny).toMatchObject([
      { decision: "deny", tool: "bash", pattern: "rm -rf /", reason: "hardline" },
    ]);
  });

  it("keeps only the newest recent denials", () => {
    const state = createPermissionState({
      mode: "plan",
      recentDenials: [
        { tool: "bash", target: "rm a", reason: "dangerous", deniedAt: "2026-07-09T01:00:00.000Z" },
        {
          tool: "write_file",
          target: "src/app.ts",
          reason: "plan mode",
          deniedAt: "2026-07-09T02:00:00.000Z",
        },
      ],
      maxRecentDenials: 1,
    });

    expect(state.recentDenials).toEqual([
      {
        tool: "write_file",
        target: "src/app.ts",
        reason: "plan mode",
        deniedAt: "2026-07-09T02:00:00.000Z",
      },
    ]);
  });

  it("creates an empty state when no rules are provided", () => {
    const state = createPermissionState({ mode: "default" });

    expect(state.rules.allow).toEqual([]);
    expect(state.rules.ask).toEqual([]);
    expect(state.rules.deny).toEqual([]);
    expect(state.recentDenials).toEqual([]);
  });
});
