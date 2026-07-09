import { describe, expect, it } from "vitest";
import { parseSlashInput } from "../../src/input/slash-parser.js";

describe("parseSlashInput", () => {
  it("普通输入不是 slash command", () => {
    expect(parseSlashInput("hello pico")).toBeNull();
  });

  it("解析 /name args", () => {
    expect(parseSlashInput("/help status")).toEqual({
      raw: "/help status",
      name: "help",
      args: "status",
      argv: ["status"],
    });
  });

  it("解析带 namespace 的命令名", () => {
    expect(parseSlashInput("/project:review src/input")).toEqual({
      raw: "/project:review src/input",
      name: "project:review",
      args: "src/input",
      argv: ["src/input"],
    });
  });

  it("解析多参数并保留引号内空格", () => {
    expect(parseSlashInput('/model "gpt-5 mini" fast')).toEqual({
      raw: '/model "gpt-5 mini" fast',
      name: "model",
      args: '"gpt-5 mini" fast',
      argv: ["gpt-5 mini", "fast"],
    });
  });
});
