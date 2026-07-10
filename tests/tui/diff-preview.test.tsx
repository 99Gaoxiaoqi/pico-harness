import { describe, expect, it } from "vitest";
import {
  formatDiffPreview,
  formatOutputPreview,
  splitDiffPreviewLines,
} from "../../src/tui/diff-preview.js";

describe("DiffPreview", () => {
  it("复用 diff 字符串并做最小高亮分类", () => {
    const lines = splitDiffPreviewLines(" unchanged\n- old\n+ new");

    expect(lines).toEqual([
      { text: " unchanged", kind: "context" },
      { text: "- old", kind: "remove" },
      { text: "+ new", kind: "add" },
    ]);
  });

  it("按行数截断过长 diff", () => {
    const diff = Array.from({ length: 8 }, (_, i) => `+ line ${i}`).join("\n");
    const output = formatDiffPreview(diff, { maxLines: 3 });

    expect(output).toContain("+ line 0");
    expect(output).toContain("+ line 2");
    expect(output).not.toContain("+ line 3");
    expect(output).toContain("已截断 5 行");
  });

  it("没有 diff 时返回空字符串", () => {
    expect(formatDiffPreview(undefined)).toBe("");
    expect(formatDiffPreview("")).toBe("");
  });

  it("输出预览在折叠和展开时都保留截断提示", () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const folded = formatOutputPreview(output, { maxLines: 3, expanded: false });
    const expanded = formatOutputPreview(output, { maxLines: 6, expanded: true });

    expect(folded).toContain("line 0");
    expect(folded).not.toContain("line 3");
    expect(folded).toContain("已截断 5 行");
    expect(expanded).toContain("line 5");
    expect(expanded).toContain("已截断 2 行");
  });
});
