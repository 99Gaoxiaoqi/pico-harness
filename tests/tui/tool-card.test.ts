// ToolCard 轻量测试:验证 agent/subagent 工具走 Claude Code 风格进度行分支。

import { describe, expect, it } from "vitest";
import { isAgentToolName } from "../../src/tui/tool-card.js";

describe("ToolCard agent tool detection", () => {
  it("识别 Pico 的子代理/委派工具", () => {
    expect(isAgentToolName("spawn_subagent")).toBe(true);
    expect(isAgentToolName("delegate_task")).toBe(true);
    expect(isAgentToolName("delegate_status")).toBe(true);
    expect(isAgentToolName("[Subagent] read_file")).toBe(true);
  });

  it("普通工具仍走标准工具卡片", () => {
    expect(isAgentToolName("read_file")).toBe(false);
    expect(isAgentToolName("bash")).toBe(false);
  });
});
