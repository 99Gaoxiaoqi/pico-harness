import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/input/command-registry.js";
import type { CommandAvailability } from "../../src/input/command-availability.js";
import type { SlashCommand } from "../../src/input/types.js";

function localCommand(
  name: string,
  aliases: readonly string[] = [],
  overrides: Partial<SlashCommand & { priority: number; availability: CommandAvailability }> = {},
): SlashCommand & { priority?: number; availability?: CommandAvailability } {
  return {
    name,
    aliases,
    description: `${name} command`,
    kind: "local",
    execute: () => ({
      type: "local",
      action: "message",
      message: name,
    }),
    ...overrides,
  };
}

describe("CommandRegistry", () => {
  it("按名称解析命令", () => {
    const registry = new CommandRegistry([localCommand("help")]);

    expect(registry.resolve("help")?.name).toBe("help");
    expect(registry.resolve("/help")?.name).toBe("help");
  });

  it("支持 alias 解析", () => {
    const registry = new CommandRegistry([localCommand("help", ["h", "?"])]);

    expect(registry.resolve("h")?.name).toBe("help");
    expect(registry.resolve("?")?.name).toBe("help");
  });

  it("为旧命令补齐 command kernel 元数据默认值", () => {
    const registry = new CommandRegistry([
      {
        name: "legacy",
        description: "legacy command",
        execute: () => ({
          type: "local",
          action: "message",
          message: "ok",
        }),
      },
    ]);

    expect(registry.resolve("legacy")).toMatchObject({
      name: "legacy",
      kind: "local",
      source: "builtin",
      aliases: [],
      isHidden: false,
      isEnabled: true,
    });
  });

  it("保留 prompt/local-jsx kind、source、argumentHint、hidden 和 enabled 元数据", () => {
    const registry = new CommandRegistry([
      localCommand("review", [], {
        kind: "prompt",
        source: "project",
        argumentHint: "<path>",
      }),
      localCommand("theme", [], {
        kind: "local-jsx",
        source: "plugin",
        isHidden: true,
      }),
      localCommand("disabled", [], {
        source: "mcp",
        isEnabled: false,
      }),
    ]);

    expect(registry.resolve("review")).toMatchObject({
      kind: "prompt",
      source: "project",
      argumentHint: "<path>",
    });
    expect(registry.resolve("theme")).toMatchObject({
      kind: "local-jsx",
      source: "plugin",
      isHidden: true,
    });
    expect(registry.resolve("disabled")).toBeUndefined();
  });

  it("拒绝重复 name 或 alias", () => {
    expect(
      () => new CommandRegistry([localCommand("help", ["h"]), localCommand("status", ["h"])]),
    ).toThrow(/Duplicate/);
  });

  it("候选包含 alias 匹配来源", () => {
    const registry = new CommandRegistry([
      localCommand("help", ["h", "?"]),
      localCommand("status", ["st"]),
    ]);

    expect(registry.detailedSuggestions("st")).toEqual([
      {
        name: "status",
        insertText: "status",
        description: "status command",
        source: "builtin",
        kind: "local",
        aliases: ["st"],
        matchedAlias: "st",
      },
    ]);
  });

  it("候选携带命令来源、类型、用法、优先级和 aliases 元数据", () => {
    const registry = new CommandRegistry([
      localCommand("review", ["rv"], {
        kind: "prompt",
        source: "project",
        usage: "/review <path>",
        argumentHint: "<path>",
        priority: 30,
      }),
    ]);

    expect(registry.detailedSuggestions("rv")).toEqual([
      {
        name: "review",
        insertText: "review",
        description: "review command",
        argumentHint: "<path>",
        source: "project",
        kind: "prompt",
        usage: "/review <path>",
        priority: 30,
        aliases: ["rv"],
        matchedAlias: "rv",
      },
    ]);
  });

  it("保留 descriptor 上的 category 和 argumentCompleter 元数据", async () => {
    const registry = new CommandRegistry([
      localCommand("agent", [], {
        category: "workspace",
        argumentCompleter: (query) => [{ value: `${query}reviewer`, description: "project agent" }],
      }),
    ]);
    const command = registry.resolve("agent");

    expect(command).toMatchObject({
      category: "workspace",
    });
    await expect(Promise.resolve(command?.argumentCompleter?.("code-"))).resolves.toEqual([
      { value: "code-reviewer", description: "project agent" },
    ]);
  });

  it("候选可按 running 和 modal 状态携带 disabled reason", () => {
    const registry = new CommandRegistry([
      localCommand("help", [], { availability: "always" }),
      localCommand("compact", [], { availability: "idle" }),
      localCommand("stop", [], { availability: "running" }),
    ]);

    const running = registry.detailedSuggestions("", { availabilityState: "running" });
    expect(running.find((suggestion) => suggestion.name === "help")).not.toHaveProperty("disabled");
    expect(running.find((suggestion) => suggestion.name === "compact")).toMatchObject({
      disabled: true,
      disabledReason: "Command is only available while idle.",
    });
    expect(running.find((suggestion) => suggestion.name === "stop")).not.toHaveProperty("disabled");

    expect(registry.detailedSuggestions("hel", { availabilityState: "modal" })[0]).toMatchObject({
      name: "help",
      disabled: true,
      disabledReason: "Command unavailable while a modal is active.",
    });
  });

  it("list can return commands annotated with real availability state", () => {
    const registry = new CommandRegistry([
      localCommand("help", [], { availability: "always", category: "help", source: "builtin" }),
      localCommand("compact", [], {
        availability: "idle",
        category: "session",
        source: "builtin",
      }),
    ]);

    const modalCommands = registry.list({
      includeDisabled: true,
      availabilityState: "modal",
    });

    expect(modalCommands.find((command) => command.name === "help")).toMatchObject({
      category: "help",
      source: "builtin",
      disabled: true,
      disabledReason: "Command unavailable while a modal is active.",
    });
    expect(modalCommands.find((command) => command.name === "compact")).toMatchObject({
      category: "session",
      source: "builtin",
      disabled: true,
    });
  });

  it("同等匹配时优先展示 priority 更高的候选", () => {
    const registry = new CommandRegistry([
      localCommand("stage", [], { priority: 10 }),
      localCommand("stash", [], { priority: 30 }),
    ]);

    expect(registry.suggestions("sta")).toEqual(["stash", "stage"]);
  });

  it("detailedSuggestions 保留完整候选,不在 registry 数据层截断", () => {
    const registry = new CommandRegistry(
      Array.from({ length: 8 }, (_, index) => localCommand(`bulk-${index}`)),
    );

    expect(registry.detailedSuggestions("bulk").map((suggestion) => suggestion.name)).toEqual([
      "bulk-0",
      "bulk-1",
      "bulk-2",
      "bulk-3",
      "bulk-4",
      "bulk-5",
      "bulk-6",
      "bulk-7",
    ]);
  });

  it("按 source 分组列出可见且启用的命令", () => {
    const registry = new CommandRegistry([
      localCommand("status", [], { source: "builtin" }),
      localCommand("review", [], { source: "project" }),
      localCommand("secret", [], { source: "project", isHidden: true }),
      localCommand("offline", [], { source: "mcp", isEnabled: false }),
    ]);

    expect(registry.list({ source: "project" }).map((command) => command.name)).toEqual(["review"]);
    expect(registry.listBySource()).toEqual([
      {
        source: "builtin",
        commands: [expect.objectContaining({ name: "status" })],
      },
      {
        source: "project",
        commands: [expect.objectContaining({ name: "review" })],
      },
    ]);
  });

  it("suggestion 返回描述和参数提示,并过滤隐藏命令", () => {
    const registry = new CommandRegistry([
      localCommand("review", [], {
        description: "Review a file",
        argumentHint: "<path>",
      }),
      localCommand("secret", [], {
        description: "Hidden command",
        isHidden: true,
      }),
    ]);

    expect(registry.detailedSuggestions("rev")).toEqual([
      {
        name: "review",
        insertText: "review",
        description: "Review a file",
        argumentHint: "<path>",
        source: "builtin",
        kind: "local",
        aliases: [],
      },
    ]);
    expect(registry.detailedSuggestions("sec").map((suggestion) => suggestion.name)).not.toContain(
      "secret",
    );
  });

  it("未知命令建议优先 alias 匹配,再按编辑距离排序", () => {
    const registry = new CommandRegistry([
      localCommand("help", ["h"]),
      localCommand("status", ["st"]),
      localCommand("model", ["models"]),
    ]);

    expect(registry.suggestions("sta")).toEqual(["status"]);
    expect(registry.suggestions("hlep").slice(0, 2)).toEqual(["help", "model"]);
  });
});
