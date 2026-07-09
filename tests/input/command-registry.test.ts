import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/input/command-registry.js";
import type { SlashCommand } from "../../src/input/types.js";

function localCommand(
  name: string,
  aliases: readonly string[] = [],
  overrides: Partial<SlashCommand> = {},
): SlashCommand {
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
        matchedAlias: "st",
      },
    ]);
  });

  it("按 source 分组列出可见且启用的命令", () => {
    const registry = new CommandRegistry([
      localCommand("status", [], { source: "builtin" }),
      localCommand("review", [], { source: "project" }),
      localCommand("secret", [], { source: "project", isHidden: true }),
      localCommand("offline", [], { source: "mcp", isEnabled: false }),
    ]);

    expect(registry.list({ source: "project" }).map((command) => command.name)).toEqual([
      "review",
    ]);
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
