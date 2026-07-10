// HookRunner 单元测试。
//
// 用真实 spawn(写 .js 辅助脚本到临时目录,经 node 执行),不 mock。
// 用 node 脚本而非 .sh/.bat,保证跨平台(POSIX/Windows)一致。
//
// 覆盖:exit code 0/2/1、stdout JSON deny、timeout、matcher 三模式、PostToolUse 不阻断。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HookRunner, matcherMatches } from "../../src/hooks/runner.js";
import type { HookMatcherGroup, HooksConfig } from "../../src/hooks/types.js";

describe("HookRunner", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-hooks-runner-"));
  });
  afterEach(async () => {
    // Windows 上 timeout kill 杀的是 shell,孙子 node 进程可能仍短暂持有临时目录句柄。
    // 重试几次 + 小延迟,避免 EBUSY 干扰测试结果(清理失败不阻断断言)。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(workDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  /**
   * 写一个 node 脚本到临时目录,返回经 shell 调用的命令字符串。
   * 脚本通过 stdin 读取 JSON(模拟 hook 协议),按指定行为 exit + 输出。
   *
   * behavior 控制脚本行为:
   *   - "exit0"            → exit 0,无输出(放行)
   *   - "exit2:<msg>"      → exit 2,stderr 输出 msg(阻断)
   *   - "exit1"            → exit 1(fail-open)
   *   - "json:<stdout>"    → exit 0,stdout 输出 JSON(按 stdout 判定)
   *   - "hang"             → 永不退出(测超时)
   */
  async function writeHookScript(behavior: string): Promise<string> {
    const scriptPath = join(
      workDir,
      `hook-${Date.now()}-${Math.random().toString(36).slice(2)}.js`,
    );
    let body: string;
    if (behavior === "hang") {
      body = `
        process.stdin.resume();
        setTimeout(() => {}, 1000000);
      `;
    } else if (behavior.startsWith("exit2:")) {
      const msg = behavior.slice("exit2:".length);
      body = `
        process.stdin.resume();
        process.stdin.on('end', () => {
          process.stderr.write(${JSON.stringify(msg)});
          process.exit(2);
        });
      `;
    } else if (behavior === "exit1") {
      body = `
        process.stdin.resume();
        process.stdin.on('end', () => process.exit(1));
      `;
    } else if (behavior.startsWith("json:")) {
      const json = behavior.slice("json:".length);
      body = `
        process.stdin.resume();
        process.stdin.on('end', () => {
          process.stdout.write(${JSON.stringify(json)});
          process.exit(0);
        });
      `;
    } else {
      // exit0 默认
      body = `
        process.stdin.resume();
        process.stdin.on('end', () => process.exit(0));
      `;
    }
    await writeFile(scriptPath, body, "utf8");
    return `node ${JSON.stringify(scriptPath)}`;
  }

  function makeRunner(config: HooksConfig): HookRunner {
    return new HookRunner(workDir, config);
  }

  describe("PreToolUse exit code 协议", () => {
    it("exit 0 + 无输出 → allow", async () => {
      const command = await writeHookScript("exit0");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", { command: "ls" }, "sess-1");
      expect(result.decision).toBe("allow");
    });

    it("exit 2 → deny,reason 取自 stderr", async () => {
      const command = await writeHookScript("exit2:blocked by policy");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", { command: "ls" }, "sess-1");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("blocked by policy");
    });

    it("exit 2 无 stderr → deny,reason 用默认文案", async () => {
      // exit2: 带空 stderr
      const command = await writeHookScript("exit2:");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("deny");
      expect(result.reason).toContain("PreToolUse hook 阻断");
    });

    it("exit 1(其他 exit code)→ fail-open allow", async () => {
      const command = await writeHookScript("exit1");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });
  });

  describe("PreToolUse stdout JSON 判定", () => {
    it("stdout {permissionDecision:'deny'} → deny + reason", async () => {
      const command = await writeHookScript(
        `json:{"permissionDecision":"deny","permissionDecisionReason":"危险命令"}`,
      );
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", { command: "rm -rf" }, "sess-1");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("危险命令");
    });

    it("stdout {decision:'block'} → deny(Codex 风格)", async () => {
      const command = await writeHookScript(`json:{"decision":"block","reason":"forbidden"}`);
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("forbidden");
    });

    it("stdout {decision:'allow'} → allow", async () => {
      const command = await writeHookScript(`json:{"decision":"allow"}`);
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });

    it("stdout {modifiedInput:{...}} → allow + 透传 modifiedInput", async () => {
      const command = await writeHookScript(`json:{"modifiedInput":{"command":"echo safe"}}`);
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", { command: "rm -rf" }, "sess-1");
      expect(result.decision).toBe("allow");
      expect(result.modifiedInput).toEqual({ command: "echo safe" });
    });

    it("stdout 非法 JSON → allow(fail-open)", async () => {
      const command = await writeHookScript("json:not-valid-json");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });
  });

  describe("timeout fail-open", () => {
    it("超时 → kill 子进程 → fail-open allow", async () => {
      const command = await writeHookScript("hang");
      const runner = makeRunner({
        PreToolUse: [{ hooks: [{ type: "command", command, timeout: 300 }] }],
      });
      const start = Date.now();
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      const elapsed = Date.now() - start;
      expect(result.decision).toBe("allow");
      // timeout 300ms,应远快于默认 60s;留宽松上界避免 CI 抖动
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe("spawn 失败 fail-open", () => {
    it("command 不存在 / 语法错 → fail-open allow", async () => {
      const runner = makeRunner({
        PreToolUse: [
          { hooks: [{ type: "command", command: "this-command-does-not-exist-xyz123" }] },
        ],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });
  });

  describe("deny 短路与多 handler", () => {
    it("首个 deny 短路,后续 handler 不再执行", async () => {
      const denyCmd = await writeHookScript("exit2:deny-first");
      const allowCmd = await writeHookScript("exit0");
      const runner = makeRunner({
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: denyCmd },
              { type: "command", command: allowCmd },
            ],
          },
        ],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("deny");
      expect(result.reason).toBe("deny-first");
    });

    it("多个 allow handler → 全部执行 → allow", async () => {
      const cmd1 = await writeHookScript("exit0");
      const cmd2 = await writeHookScript("exit0");
      const runner = makeRunner({
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: cmd1 },
              { type: "command", command: cmd2 },
            ],
          },
        ],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });
  });

  describe("无匹配配置 → allow", () => {
    it("config 无 PreToolUse 字段 → allow", async () => {
      const runner = makeRunner({});
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });

    it("matcher 不命中 → allow(handler 不执行)", async () => {
      const denyCmd = await writeHookScript("exit2:should-not-run");
      const runner = makeRunner({
        PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: denyCmd }] }],
      });
      const result = await runner.runPreToolUse("bash", {}, "sess-1");
      expect(result.decision).toBe("allow");
    });
  });

  describe("PostToolUse fire-and-forget", () => {
    it("PostToolUse exit 2 不阻断(返回 void)", async () => {
      const command = await writeHookScript("exit2:post-deny");
      const runner = makeRunner({
        PostToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      // 不应抛错,PostToolUse 永远不阻断
      await expect(
        runner.runPostToolUse("bash", {}, "tool output", "sess-1"),
      ).resolves.toBeUndefined();
    });

    it("PostToolUse 正常 exit 0 → 不抛", async () => {
      const command = await writeHookScript("exit0");
      const runner = makeRunner({
        PostToolUse: [{ hooks: [{ type: "command", command }] }],
      });
      await expect(
        runner.runPostToolUse("bash", {}, "tool output", "sess-1"),
      ).resolves.toBeUndefined();
    });
  });

  describe("stdin 传 input JSON", () => {
    it("hook 通过 stdin 收到完整 HookInput", async () => {
      // 写一个脚本:把收到的 stdin 写到文件,以便断言内容
      const outFile = join(workDir, "received-input.json");
      const scriptPath = join(workDir, "echo-stdin.js");
      await writeFile(
        scriptPath,
        `
          let data = "";
          process.stdin.on("data", (c) => (data += c.toString()));
          process.stdin.on("end", () => {
            require("fs").writeFileSync(${JSON.stringify(outFile)}, data);
            process.exit(0);
          });
        `,
        "utf8",
      );
      const runner = makeRunner({
        PreToolUse: [
          { hooks: [{ type: "command", command: `node ${JSON.stringify(scriptPath)}` }] },
        ],
      });
      await runner.runPreToolUse("bash", { command: "ls" }, "sess-xyz");

      const { readFile } = await import("node:fs/promises");
      const received = JSON.parse(await readFile(outFile, "utf8")) as Record<string, unknown>;
      expect(received.session_id).toBe("sess-xyz");
      expect(received.cwd).toBe(workDir);
      expect(received.hook_event_name).toBe("PreToolUse");
      expect(received.tool_name).toBe("bash");
      expect(received.tool_input).toEqual({ command: "ls" });
    });
  });
});

describe("matcherMatches 三模式", () => {
  const mk = (matcher: string | undefined): HookMatcherGroup => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [],
  });

  it("matcher 省略 → 全匹配", () => {
    expect(matcherMatches(mk(undefined), "bash")).toBe(true);
    expect(matcherMatches(mk(undefined), "anything")).toBe(true);
  });

  it("matcher 空 → 全匹配", () => {
    expect(matcherMatches(mk(""), "bash")).toBe(true);
  });

  it("matcher '*' → 全匹配", () => {
    expect(matcherMatches(mk("*"), "bash")).toBe(true);
    expect(matcherMatches(mk("*"), "write_file")).toBe(true);
  });

  it("纯名称精确匹配", () => {
    expect(matcherMatches(mk("bash"), "bash")).toBe(true);
    expect(matcherMatches(mk("bash"), "write_file")).toBe(false);
  });

  it("纯名称 | 分隔精确匹配", () => {
    expect(matcherMatches(mk("bash|edit_file"), "bash")).toBe(true);
    expect(matcherMatches(mk("bash|edit_file"), "edit_file")).toBe(true);
    expect(matcherMatches(mk("bash|edit_file"), "write_file")).toBe(false);
  });

  it("含特殊字符(非纯字母数字)→ 正则匹配", () => {
    // ".*" 含 . 走正则模式
    expect(matcherMatches(mk(".*"), "anything")).toBe(true);
    // "^bash$" 含 ^ $ 走正则模式
    expect(matcherMatches(mk("^bash$"), "bash")).toBe(true);
    expect(matcherMatches(mk("^bash$"), "bash2")).toBe(false);
    // 正则前缀匹配:write.* 命中 write_file
    expect(matcherMatches(mk("write.*"), "write_file")).toBe(true);
    expect(matcherMatches(mk("write.*"), "bash")).toBe(false);
  });

  it("'write|edit' 是纯 [A-Za-z0-9_|] → 走精确 | 分隔匹配(非正则)", () => {
    // 注:| 在纯名称集合内,故按精确名匹配,不是正则
    expect(matcherMatches(mk("write|edit"), "write")).toBe(true);
    expect(matcherMatches(mk("write|edit"), "edit")).toBe(true);
    // 精确匹配不命中 write_file
    expect(matcherMatches(mk("write|edit"), "write_file")).toBe(false);
  });

  it("非法正则 → 不匹配(保守)", () => {
    expect(matcherMatches(mk("(["), "bash")).toBe(false);
  });
});
