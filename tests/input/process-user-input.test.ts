import { describe, expect, it } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { processUserInput } from "../../src/input/process-user-input.js";

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
      expect(result.result.message).toContain("/help");
      expect(result.result.message).toContain("/clear");
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
