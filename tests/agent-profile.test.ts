// agent-profile 加载器单测:YAML 解析 / 校验 / 防滥用。
//
// 覆盖:
// - 正常 YAML 解析为 AgentProfile[]
// - 文件不存在静默返回 []
// - YAML 语法错误返回 [] + warn(不抛)
// - 工具白名单:未知名被忽略,全空则跳过该角色
// - maxTurns 上限:超过 50 截断,非正整数忽略
// - name 必填+去重(后者覆盖前者)
// - systemPrompt 必填,空则跳过

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileLoader, KNOWN_TOOL_NAMES } from "../src/tools/agent-profile.js";

describe("AgentProfileLoader", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-agent-profile-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** 写 .claw/agents.yaml */
  async function writeAgentsYaml(content: string): Promise<void> {
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await writeFile(join(workDir, ".claw", "agents.yaml"), content, "utf8");
  }

  it("正常 YAML 解析为角色列表", async () => {
    await writeAgentsYaml(`
agents:
  - name: auditor
    description: "安全审查员"
    systemPrompt: "你是审查员"
    systemPromptOverride: true
    maxTurns: 5
    tools:
      - read_file
      - bash
  - name: tester
    description: "测试员"
    systemPrompt: "你是测试员"
    tools:
      - read_file
      - write_file
`);
    const profiles = await new AgentProfileLoader(workDir).load();

    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.name).toBe("auditor");
    expect(profiles[0]!.systemPromptOverride).toBe(true);
    expect(profiles[0]!.maxTurns).toBe(5);
    expect(profiles[0]!.tools).toEqual(["read_file", "bash"]);
    expect(profiles[1]!.name).toBe("tester");
    expect(profiles[1]!.systemPromptOverride).toBeUndefined();
    expect(profiles[1]!.maxTurns).toBeUndefined();
  });

  it("文件不存在时静默返回空数组", async () => {
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toEqual([]);
  });

  it("YAML 语法错误返回空数组(不抛异常)", async () => {
    await writeAgentsYaml("agents: [invalid: yaml: - - -");
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toEqual([]);
  });

  it("agents 字段缺失或非数组返回空", async () => {
    await writeAgentsYaml("foo: bar\n");
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toEqual([]);
  });

  it("工具白名单:未知名被忽略", async () => {
    await writeAgentsYaml(`
agents:
  - name: custom
    systemPrompt: "你是..."
    tools:
      - read_file
      - unknown_tool
      - edit_file
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.tools).toEqual(["read_file", "edit_file"]);
  });

  it("工具全为未知或空数组时跳过该角色", async () => {
    await writeAgentsYaml(`
agents:
  - name: empty-tools
    systemPrompt: "..."
    tools: []
  - name: bad-tools
    systemPrompt: "..."
    tools:
      - totally_unknown
  - name: ok
    systemPrompt: "..."
    tools:
      - read_file
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("ok");
  });

  it("maxTurns 超过上限(50)被截断", async () => {
    await writeAgentsYaml(`
agents:
  - name: long-runner
    systemPrompt: "..."
    maxTurns: 999
    tools: [read_file]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles[0]!.maxTurns).toBe(50);
  });

  it("maxTurns 非正整数被忽略(用默认)", async () => {
    await writeAgentsYaml(`
agents:
  - name: bad-turns
    systemPrompt: "..."
    maxTurns: -3
    tools: [read_file]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles[0]!.maxTurns).toBeUndefined();
  });

  it("name 必填,缺失或空白的跳过", async () => {
    await writeAgentsYaml(`
agents:
  - name: ""
    systemPrompt: "..."
    tools: [read_file]
  - name: ok
    systemPrompt: "..."
    tools: [read_file]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("ok");
  });

  it("重名角色后者覆盖前者", async () => {
    await writeAgentsYaml(`
agents:
  - name: dup
    systemPrompt: "first"
    tools: [read_file]
  - name: dup
    systemPrompt: "second"
    tools: [bash]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.systemPrompt).toBe("second");
    expect(profiles[0]!.tools).toEqual(["bash"]);
  });

  it("systemPrompt 必填,空的跳过", async () => {
    await writeAgentsYaml(`
agents:
  - name: no-prompt
    systemPrompt: ""
    tools: [read_file]
  - name: ok
    systemPrompt: "valid"
    tools: [read_file]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.name).toBe("ok");
  });

  it("description 缺失时用 name 兜底", async () => {
    await writeAgentsYaml(`
agents:
  - name: nodesc
    systemPrompt: "..."
    tools: [read_file]
`);
    const profiles = await new AgentProfileLoader(workDir).load();
    expect(profiles[0]!.description).toBe("nodesc");
  });

  it("KNOWN_TOOL_NAMES 包含五个基础工具", () => {
    expect(KNOWN_TOOL_NAMES.has("read_file")).toBe(true);
    expect(KNOWN_TOOL_NAMES.has("write_file")).toBe(true);
    expect(KNOWN_TOOL_NAMES.has("edit_file")).toBe(true);
    expect(KNOWN_TOOL_NAMES.has("bash")).toBe(true);
    expect(KNOWN_TOOL_NAMES.has("skill_view")).toBe(true);
  });
});
