import { describe, expect, it } from "vitest";
import { parseMentions } from "../../src/input/mentions.js";

describe("parseMentions", () => {
  it("parses path mentions mixed with Chinese text", () => {
    const mentions = parseMentions("请查看 @src/index.ts 和 @docs");

    expect(mentions).toMatchObject([
      {
        kind: "path",
        raw: "@src/index.ts",
        target: "src/index.ts",
      },
      {
        kind: "path",
        raw: "@docs",
        target: "docs",
      },
    ]);
    expect(mentions[0]?.start).toBe("请查看 ".length);
  });

  it("parses quoted paths with spaces", () => {
    const mentions = parseMentions('compare @"docs/path with spaces.md" please');

    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      kind: "path",
      raw: '@"docs/path with spaces.md"',
      target: "docs/path with spaces.md",
    });
  });

  it("parses line references", () => {
    const mentions = parseMentions("read @src/app.ts#L5 and @src/lib.ts#L10-L20");

    expect(mentions).toMatchObject([
      {
        kind: "path",
        target: "src/app.ts",
        lineStart: 5,
        lineEnd: 5,
      },
      {
        kind: "path",
        target: "src/lib.ts",
        lineStart: 10,
        lineEnd: 20,
      },
    ]);
  });

  it("preserves plain text while parsing file mentions with optional line ranges", () => {
    const input = "请读 @src/foo.ts, 再看 @src/foo.ts#L10 和 @src/foo.ts#L10-L20。";
    const mentions = parseMentions(input);

    expect(input).toBe("请读 @src/foo.ts, 再看 @src/foo.ts#L10 和 @src/foo.ts#L10-L20。");
    expect(mentions).toMatchObject([
      {
        kind: "path",
        raw: "@src/foo.ts",
        target: "src/foo.ts",
      },
      {
        kind: "path",
        raw: "@src/foo.ts#L10",
        target: "src/foo.ts",
        lineStart: 10,
        lineEnd: 10,
      },
      {
        kind: "path",
        raw: "@src/foo.ts#L10-L20",
        target: "src/foo.ts",
        lineStart: 10,
        lineEnd: 20,
      },
    ]);
  });

  it("parses skill and agent mentions", () => {
    const mentions = parseMentions("use @skill:review then ask @agent:tester");

    expect(mentions).toMatchObject([
      {
        kind: "skill",
        raw: "@skill:review",
        target: "review",
      },
      {
        kind: "agent",
        raw: "@agent:tester",
        target: "tester",
      },
    ]);
  });
});
