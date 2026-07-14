import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentProfileLoader } from "../src/tools/agent-profile.js";
import {
  MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS,
  MAX_SUBAGENT_TURNS,
  parseEphemeralAgentSpec,
} from "../src/tools/subagent-spec.js";

describe("自然语言临时 Agent 合约集成", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("同时归一化临时 Agent 覆盖与持久 Profile 路由默认值", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-subagent-spec-"));
    tempDirs.push(workDir);
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "agents.yaml"),
      [
        "agents:",
        "  - name: reviewer",
        "    description: 安全审查",
        "    systemPrompt: 只报告问题，不修改文件。",
        "    modelRouteId: volcengine/deepseek-v4-pro",
        "    thinkingEffort: high",
        "    maxTurns: 12",
        "    tools: [read_file, grep]",
      ].join("\n"),
      "utf8",
    );

    const [profile] = await new AgentProfileLoader(workDir).load();
    const parsed = parseEphemeralAgentSpec({
      name: "one-off-reviewer",
      instructions: "只检查认证模块。",
      model_route: "volcengine/glm-5.2",
      thinking_effort: "max",
      max_turns: 999,
    });

    expect(profile).toMatchObject({
      modelRouteId: "volcengine/deepseek-v4-pro",
      thinkingEffort: "high",
      maxTurns: 12,
    });
    expect(parsed).toEqual({
      ok: true,
      spec: {
        name: "one-off-reviewer",
        instructions: "只检查认证模块。",
        modelRouteId: "volcengine/glm-5.2",
        thinkingEffort: "max",
        maxTurns: MAX_SUBAGENT_TURNS,
      },
    });
  });

  it("在进入模型路由前拒绝越界临时 instructions", () => {
    const parsed = parseEphemeralAgentSpec({
      instructions: "x".repeat(MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS + 1),
      model_route: "volcengine/glm-5.2",
    });

    expect(parsed).toEqual({
      ok: false,
      error: `agent.instructions 不能超过 ${MAX_EPHEMERAL_AGENT_INSTRUCTIONS_CHARS} 个字符`,
    });
  });
});
