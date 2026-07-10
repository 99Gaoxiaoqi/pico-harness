import { describe, expect, it } from "vitest";
import { renderSkillActivation, renderSkillBody } from "../../src/input/skill-activation.js";

describe("skill activation", () => {
  it("wraps an explicitly activated skill as a synthetic user prompt", () => {
    const result = renderSkillActivation({
      name: "review",
      args: "src/a.ts",
      body: "Review $0",
      sourcePath: "/repo/.claude/skills/review/SKILL.md",
      trigger: "user-slash",
    });

    expect(result.prompt).toBe(
      [
        'User explicitly activated skill "review". Follow the loaded skill instructions and use them to complete the request.',
        "",
        '<pico-skill-loaded name="review" trigger="user-slash" source="/repo/.claude/skills/review/SKILL.md">',
        "Review src/a.ts",
        "</pico-skill-loaded>",
      ].join("\n"),
    );
    expect(result.metadata).toEqual({
      skillName: "review",
      skillArgs: "src/a.ts",
      skillSourcePath: "/repo/.claude/skills/review/SKILL.md",
      skillTrigger: "user-slash",
    });
  });

  it("renders Claude Code argument placeholders with zero-based indexes", () => {
    expect(
      renderSkillBody(
        "Raw: $ARGUMENTS\nFirst: $ARGUMENTS[0] / $0\nSecond: $ARGUMENTS[1] / $1\nMissing: $9",
        'src/a.ts "main branch" --strict',
      ),
    ).toBe(
      'Raw: src/a.ts "main branch" --strict\nFirst: src/a.ts / src/a.ts\nSecond: main branch / main branch\nMissing: ',
    );
  });

  it("preserves raw arguments when replacing $ARGUMENTS", () => {
    expect(renderSkillBody("Run $ARGUMENTS", "  fix   login  ")).toBe("Run   fix   login  ");
  });

  it("appends arguments when the skill has no placeholder", () => {
    expect(renderSkillBody("Follow this workflow", "fix login")).toBe(
      "Follow this workflow\n\nARGUMENTS: fix login",
    );
  });

  it("does not append an arguments section when no arguments were supplied", () => {
    expect(renderSkillBody("Follow this workflow", "")).toBe("Follow this workflow");
  });

  it("escapes every XML attribute value", () => {
    const result = renderSkillActivation({
      name: "review&\"<'>",
      args: "",
      body: "Follow the workflow",
      sourcePath: "/repo/a&\"<'>/SKILL.md",
      trigger: "user-slash",
    });

    expect(result.prompt).toContain(
      '<pico-skill-loaded name="review&amp;&quot;&lt;&apos;&gt;" trigger="user-slash" source="/repo/a&amp;&quot;&lt;&apos;&gt;/SKILL.md">',
    );
  });
});
