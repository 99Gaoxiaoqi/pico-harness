import { describe, expect, it } from "vitest";
import {
  getSlashArgumentHints,
  getSlashArgumentHintsForInput,
} from "../../src/input/slash-argument-hints.js";

describe("slash argument hints", () => {
  it("lists common values for commands with static arguments", () => {
    expect(getSlashArgumentHints("thinking").map((hint) => hint.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(getSlashArgumentHints("permissions").map((hint) => hint.value)).toEqual([
      "ask",
      "default",
      "auto",
      "yolo",
      "plan",
    ]);
    expect(getSlashArgumentHints("mode").map((hint) => hint.value)).toEqual([
      "default",
      "plan",
      "auto",
      "yolo",
    ]);
    expect(getSlashArgumentHints("yolo").map((hint) => hint.value)).toEqual(["on", "off"]);
    expect(getSlashArgumentHints("auto").map((hint) => hint.value)).toEqual(["on", "off"]);
  });

  it("filters candidates by case-insensitive argument prefix", () => {
    expect(getSlashArgumentHints("/permissions", "A").map((hint) => hint.value)).toEqual([
      "ask",
      "auto",
    ]);
    expect(getSlashArgumentHints("model", "ki").map((hint) => hint.value)).toEqual([
      "kimi-k2.5",
    ]);
    expect(getSlashArgumentHints("effort", "h").map((hint) => hint.value)).toEqual(["high"]);
  });

  it("returns no candidates for unknown commands", () => {
    expect(getSlashArgumentHints("help")).toEqual([]);
    expect(getSlashArgumentHints("unknown")).toEqual([]);
  });

  it("derives the current argument prefix from full input and cursor", () => {
    expect(getSlashArgumentHintsForInput("/mode ", 6).map((hint) => hint.value)).toEqual([
      "default",
      "plan",
      "auto",
      "yolo",
    ]);
    expect(getSlashArgumentHintsForInput("/thinking me", 12).map((hint) => hint.value)).toEqual([
      "medium",
    ]);
  });

  it("does not offer argument hints while editing the command name or later arguments", () => {
    expect(getSlashArgumentHintsForInput("/mo", 3)).toEqual([]);
    expect(getSlashArgumentHintsForInput("/mode auto ", 11)).toEqual([]);
    expect(getSlashArgumentHintsForInput("hello /mode ", 12)).toEqual([]);
  });
});
