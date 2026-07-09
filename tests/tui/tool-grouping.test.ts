import { describe, expect, it } from "vitest";
import { groupToolEntries } from "../../src/tui/tool-grouping.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

describe("groupToolEntries", () => {
  it("合并连续相邻的同类已完成普通工具调用", () => {
    const entries: TuiEntry[] = [
      tool("read_file", '{"path":"a.ts"}', "success", "10 字节 · a"),
      tool("read_file", '{"path":"b.ts"}', "success", "20 字节 · b"),
      tool("read_file", '{"path":"c.ts"}', "success", "30 字节 · c"),
    ];

    expect(groupToolEntries(entries)).toEqual([
      {
        kind: "tool",
        name: "read_file",
        status: "success",
        summary: "3 calls · 3 success · a.ts",
        args: JSON.stringify({
          groupedCount: 3,
          calls: ["a.ts", "b.ts", "c.ts"],
        }),
      },
    ]);
  });

  it("非 tool 条目会切断分组", () => {
    const entries: TuiEntry[] = [
      tool("read_file", '{"path":"a.ts"}', "done"),
      { kind: "assistant", content: "中间回复" },
      tool("read_file", '{"path":"b.ts"}', "done"),
    ];

    expect(groupToolEntries(entries)).toEqual(entries);
  });

  it("running 状态不和已完成状态合并", () => {
    const entries: TuiEntry[] = [
      tool("bash", '{"command":"npm test"}', "running"),
      tool("bash", '{"command":"npm test"}', "success", "pass"),
    ];

    expect(groupToolEntries(entries)).toEqual(entries);
  });

  it("agent/subagent 工具不参与合并", () => {
    const entries: TuiEntry[] = [
      tool("delegate_task", '{"agent_name":"reviewer"}', "success", "done"),
      tool("delegate_task", '{"agent_name":"tester"}', "success", "done"),
      tool("[Subagent] read_file", '{"path":"a.ts"}', "success", "done"),
      tool("[Subagent] read_file", '{"path":"b.ts"}', "success", "done"),
    ];

    expect(groupToolEntries(entries)).toEqual(entries);
  });

  it("不同工具不合并,同工具不同完成状态聚合为失败组", () => {
    const entries: TuiEntry[] = [
      tool("read_file", '{"path":"a.ts"}', "success", "ok"),
      tool("bash", '{"command":"npm test"}', "success", "ok"),
      tool("bash", '{"command":"npm lint"}', "error", "failed"),
    ];

    expect(groupToolEntries(entries)).toEqual([
      entries[0],
      {
        kind: "tool",
        name: "bash",
        status: "error",
        summary: "2 calls · 1 failed · npm test",
        args: JSON.stringify({
          groupedCount: 2,
          calls: ["npm test", "npm lint"],
        }),
      },
    ]);
  });
});

function tool(name: string, args: string, status: Extract<TuiEntry, { kind: "tool" }>["status"], summary?: string): TuiEntry {
  return { kind: "tool", name, args, status, summary };
}
