import { describe, expect, it } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { CommandRegistry } from "../../src/input/command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import type { SlashCommand } from "../../src/input/types.js";

describe("processUserInput", () => {
  it("普通输入进入 prompt", async () => {
    const result = await processUserInput("hello pico");

    expect(result).toEqual({
      type: "prompt",
      raw: "hello pico",
      prompt: "hello pico",
    });
  });

  it("/help 返回本地命令结果", async () => {
    const registry = createBuiltinCommandRegistry();
    const result = await processUserInput("/help", { registry });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.command).toBe("help");
      expect(result.result.action).toBe("help");
      expect(result.result.ui).toEqual({ kind: "open-panel", panel: "help" });
      expect(result.result.message).toContain("/help");
      expect(result.result.message).toContain("/clear");
    }
  });

  it("/help 默认只展示核心命令,避免外部技能命令刷屏", async () => {
    const externalCommand: SlashCommand = {
      name: "huge-external-skill",
      description: "A very noisy external skill command",
      usage: "/huge-external-skill",
      kind: "prompt",
      execute: () => ({ type: "prompt", prompt: "external" }),
    };
    const registry = new CommandRegistry([
      ...createBuiltinCommandRegistry().list(),
      externalCommand,
    ]);

    const result = await processUserInput("/help", { registry });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.result.message).toContain("/help");
      expect(result.result.message).toContain("/skills");
      expect(result.result.message).not.toContain("huge-external-skill");
      expect(result.result.message).toContain("Use /help <command> for any command");
    }
  });

  it("/help <external> 仍然能查看外部命令详情", async () => {
    const externalCommand: SlashCommand = {
      name: "huge-external-skill",
      description: "A very noisy external skill command",
      usage: "/huge-external-skill <topic>",
      kind: "prompt",
      execute: () => ({ type: "prompt", prompt: "external" }),
    };
    const registry = new CommandRegistry([
      ...createBuiltinCommandRegistry().list(),
      externalCommand,
    ]);

    const result = await processUserInput("/help huge-external-skill", { registry });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.result.message).toContain("Command: /huge-external-skill");
      expect(result.result.message).toContain("Usage: /huge-external-skill <topic>");
    }
  });

  it("/help <command> 展示 usage、aliases、说明和参数", async () => {
    const registry = createBuiltinCommandRegistry();
    const result = await processUserInput("/help thinking", { registry });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.command).toBe("help");
      expect(result.result.message).toContain("Command: /thinking");
      expect(result.result.message).toContain("Usage: /thinking <off|low|medium|high>");
      expect(result.result.message).toContain("Aliases: /effort");
      expect(result.result.message).toContain("Description: Show or change thinking effort");
      expect(result.result.message).toContain("Parameters:");
      expect(result.result.message).toContain("<off|low|medium|high>");
    }
  });

  it("/help <alias> 会展示原命令帮助", async () => {
    const registry = createBuiltinCommandRegistry();
    const result = await processUserInput("/help h", { registry });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.result.message).toContain("Command: /help");
      expect(result.result.message).toContain("Aliases: /h, /?");
    }
  });

  it("/clear 返回清屏本地命令结果", async () => {
    const result = await processUserInput("/clear", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.result.action).toBe("clear");
    }
  });

  it("未知 /xxx 返回 unknown-command", async () => {
    const result = await processUserInput("/xxx", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result).toMatchObject({
      type: "unknown-command",
      command: "xxx",
    });
  });

  it("格式非法的 slash 输入不会退化成普通 prompt", async () => {
    const registry = createBuiltinCommandRegistry();

    for (const input of ["/", "/ 中文", "/模式", "/mode("]) {
      const result = await processUserInput(input, { registry });

      expect(result.type, input).toBe("unknown-command");
      if (result.type === "unknown-command") {
        expect(result.raw).toBe(input);
        expect(result.message).toContain("Invalid slash command");
      }
    }
  });

  it("未知命令建议按 alias 和编辑距离排序", async () => {
    const result = await processUserInput("/hlep", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("unknown-command");
    if (result.type === "unknown-command") {
      expect(result.suggestions[0]).toBe("help");
    }
  });

  it("alias 会解析到原命令", async () => {
    const result = await processUserInput("/h", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("local-command");
    if (result.type === "local-command") {
      expect(result.command).toBe("help");
    }
  });

  it("参数会传给命令处理器", async () => {
    const result = await processUserInput("/skill react-expert", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("prompt-command");
    if (result.type === "prompt-command") {
      expect(result.command).toBe("skill");
      expect(result.result.prompt).toContain("react-expert");
      expect(result.result.metadata).toEqual({ skillName: "react-expert" });
    }
  });
});
