import { describe, expect, it } from "vitest";
import {
  compactCommand,
  compactText,
  compactToolName,
  summarizeToolTarget,
} from "../../src/tui/tool-format.js";

describe("tool-format", () => {
  it("压缩常见工具名", () => {
    expect(compactToolName("read_file")).toBe("read");
    expect(compactToolName("edit_file")).toBe("edit");
    expect(compactToolName("bash")).toBe("bash");
  });

  it("把 curl 命令压缩成稳定的一行目标", () => {
    const command = 'curl -s -H "Accept: application/json" "https://aihot.virxact.com/api/news?limit=20"';

    expect(compactCommand(command, 80)).toBe("curl aihot.virxact.com/api/news?limit=20");
  });

  it("长文本中间省略,不产生换行", () => {
    const value = "中文路径/".repeat(20);
    const compacted = compactText(value, 24);

    expect(compacted).toContain("…");
    expect(compacted).not.toContain("\n");
    expect(compacted.length).toBeLessThanOrEqual(24);
  });

  it("从工具参数提取目标,非法 JSON 安全返回 undefined", () => {
    expect(summarizeToolTarget("read_file", JSON.stringify({ path: "src/tui/tool-card.tsx" }))).toBe(
      "src/tui/tool-card.tsx",
    );
    expect(summarizeToolTarget("bash", JSON.stringify({ command: "npm test -- --run" }))).toBe(
      "npm test -- --run",
    );
    expect(summarizeToolTarget("bash", "{bad json")).toBeUndefined();
  });
});
