import { describe, expect, it, vi } from "vitest";
import { createHookManagementCommands } from "../../src/hooks/management/commands.js";
import type { HookManagementService } from "../../src/hooks/management/service.js";

describe("Hook management command adapter", () => {
  it("仅路由固定管理动作和 handler id", async () => {
    const management = {
      list: vi.fn(() => []),
      reload: vi.fn(async () => true),
    } as unknown as HookManagementService;
    const hookify = vi.fn(async () => ({
      applied: false,
      proposal: {
        workDir: "/workspace",
        targetPath: "/workspace/.claw/hookify.rule.local.md",
        content: "content",
        diff: "diff",
        rule: {
          version: 1 as const,
          id: "rule",
          description: "warn",
          event: "all" as const,
          action: "warn" as const,
          condition: { op: "contains" as const, value: "x" },
          enabled: true,
        },
      },
    }));
    const [hooks, hookifyCommand] = createHookManagementCommands({ management, hookify });
    const context = {};
    const list = await hooks!.execute(
      { raw: "/hooks", name: "hooks", args: "", argv: [] },
      context,
    );
    expect(list).toMatchObject({
      type: "local",
      message: "No Hooks configured.",
      ui: { kind: "open-panel", panel: "hooks" },
    });
    const unknown = await hooks!.execute(
      { raw: "/hooks shell rm", name: "hooks", args: "shell rm", argv: ["shell", "rm"] },
      context,
    );
    expect(unknown).toMatchObject({ type: "local", message: expect.stringContaining("Usage") });
    await hookifyCommand!.execute(
      {
        raw: "/hookify warn secrets",
        name: "hookify",
        args: "warn secrets",
        argv: ["warn", "secrets"],
      },
      context,
    );
    expect(hookify).toHaveBeenCalledWith("warn secrets");
  });
});
