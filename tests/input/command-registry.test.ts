import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../../src/input/command-registry.js";
import type { SlashCommand } from "../../src/input/types.js";

function localCommand(name: string, aliases: readonly string[] = []): SlashCommand {
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

  it("拒绝重复 name 或 alias", () => {
    expect(
      () => new CommandRegistry([localCommand("help", ["h"]), localCommand("status", ["h"])]),
    ).toThrow(/Duplicate/);
  });
});
