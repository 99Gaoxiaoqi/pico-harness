import { describe, expect, it } from "vitest";
import {
  annotateCommandAvailability,
  getCommandAvailability,
} from "../../src/input/command-availability.js";
import type { SlashCommand } from "../../src/input/types.js";

function command(
  name: string,
  availability?: "always" | "idle" | "running",
): SlashCommand & {
  availability?: "always" | "idle" | "running";
} {
  return {
    name,
    description: `${name} command`,
    availability,
    execute: () => ({
      type: "local",
      action: "message",
      message: name,
    }),
  };
}

describe("command availability", () => {
  it("idle 状态允许 always 和 idle 命令,禁用 running 命令", () => {
    expect(getCommandAvailability(command("help", "always"), "idle")).toEqual({
      available: true,
    });
    expect(getCommandAvailability(command("compact", "idle"), "idle")).toEqual({
      available: true,
    });
    expect(getCommandAvailability(command("stop", "running"), "idle")).toEqual({
      available: false,
      disabledReason: "Command is only available while running.",
    });
  });

  it("running 状态允许 always 和 running 命令,禁用 idle 命令", () => {
    expect(getCommandAvailability(command("help", "always"), "running")).toEqual({
      available: true,
    });
    expect(getCommandAvailability(command("stop", "running"), "running")).toEqual({
      available: true,
    });
    expect(getCommandAvailability(command("compact", "idle"), "running")).toEqual({
      available: false,
      disabledReason: "Command is only available while idle.",
    });
  });

  it("modal 状态禁用所有命令并返回原因", () => {
    expect(getCommandAvailability(command("help", "always"), "modal")).toEqual({
      available: false,
      disabledReason: "Command unavailable while a modal is active.",
    });
  });

  it("给候选命令标记 disabled 和 disabledReason", () => {
    const candidates = [
      command("help", "always"),
      command("compact", "idle"),
      command("stop", "running"),
    ];

    expect(annotateCommandAvailability(candidates, "running")).toEqual([
      expect.objectContaining({ name: "help", disabled: false }),
      expect.objectContaining({
        name: "compact",
        disabled: true,
        disabledReason: "Command is only available while idle.",
      }),
      expect.objectContaining({ name: "stop", disabled: false }),
    ]);
  });
});
