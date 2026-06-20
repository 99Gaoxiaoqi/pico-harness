// 高危命令拦截与人工审批的单元测试。
// 覆盖:isDangerousCommand 各模式 / ApprovalManager 挂起-唤醒 / 超时 Reject / Middleware 拦截放行。

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  ApprovalManager,
  isDangerousCommand,
  type ApprovalNotice,
} from "../src/approval/manager.js";
import { ToolRegistry, EchoTool } from "../src/tools/registry-impl.js";
import type { BaseTool } from "../src/tools/registry.js";
import type { ToolCall, ToolDefinition } from "../src/schema/message.js";

/** 构造一个假的 bash 工具(仅用于测试拦截,不真正执行);executedRef 标记是否被执行 */
function fakeBashTool(executedRef: { executed: boolean }): BaseTool {
  return {
    name: () => "bash",
    definition: (): ToolDefinition => ({
      name: "bash",
      description: "",
      inputSchema: { type: "object" },
    }),
    async execute() {
      executedRef.executed = true;
      return "should not reach";
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isDangerousCommand", () => {
  it("纯读取工具默认放行", () => {
    expect(isDangerousCommand("read_file", '{"path":"a.txt"}')).toBe(false);
    expect(isDangerousCommand("echo", "{}")).toBe(false);
  });

  it("bash 命中 rm -r 级联删除", () => {
    expect(isDangerousCommand("bash", '{"command":"rm -rf /var/log/*"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"rm -r ./dist"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"rm --recursive old"}')).toBe(true);
  });

  it("bash 命中所有 rm 变体(单文件/不带 f)", () => {
    expect(isDangerousCommand("bash", '{"command":"rm /tmp/x"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"rm -f /tmp/x"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"rm -fr /tmp/x"}')).toBe(true);
  });

  it("bash 命中 rmdir / find -delete / unlink", () => {
    expect(isDangerousCommand("bash", '{"command":"rmdir /tmp/olddir"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"find /tmp -delete"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"find . -exec rm {} +"}')).toBe(true);
    expect(isDangerousCommand("bash", '{"command":"unlink /tmp/file"}')).toBe(true);
  });

  it("bash 命中 sudo 提权", () => {
    expect(isDangerousCommand("bash", '{"command":"sudo apt install x"}')).toBe(true);
  });

  it("bash 命中 drop 数据库删除", () => {
    expect(isDangerousCommand("bash", '{"command":"echo DROP TABLE users"}')).toBe(true);
  });

  it("bash 命中 mkfs 格式化", () => {
    expect(isDangerousCommand("bash", '{"command":"mkfs.ext4 /dev/sda"}')).toBe(true);
  });

  it("bash 命中 kubectl delete", () => {
    expect(isDangerousCommand("bash", '{"command":"kubectl delete pod foo"}')).toBe(true);
  });

  it("bash 命中 git push --force", () => {
    expect(isDangerousCommand("bash", '{"command":"git push -f origin main"}')).toBe(true);
  });

  it("bash 命中 chmod 777", () => {
    expect(isDangerousCommand("bash", '{"command":"chmod 777 /tmp"}')).toBe(true);
  });

  it("bash 安全命令不命中", () => {
    expect(isDangerousCommand("bash", '{"command":"ls -la"}')).toBe(false);
    expect(isDangerousCommand("bash", '{"command":"git status"}')).toBe(false);
    expect(isDangerousCommand("bash", '{"command":"echo hello"}')).toBe(false);
    expect(isDangerousCommand("bash", '{"command":"npm install"}')).toBe(false);
  });

  it("write_file 不命中普通文件(bash 重定向模式仅对 bash 生效)", () => {
    // write_file 的危险检测目前与 bash 共用同一批正则,
    // 其中 >.*\.(ts|js...)$ 是针对 bash 重定向的,write_file 路径不触发
    expect(isDangerousCommand("write_file", '{"path":"notes.txt","content":"x"}')).toBe(false);
    expect(isDangerousCommand("write_file", '{"path":"src/index.ts","content":"x"}')).toBe(false);
  });
});

describe("ApprovalManager", () => {
  it("waitForApproval 挂起,resolveApproval 唤醒为允许", async () => {
    const mgr = new ApprovalManager();
    const notices: ApprovalNotice[] = [];
    const notify = (n: ApprovalNotice) => notices.push(n);

    const promise = mgr.waitForApproval("t1", "bash", "rm -rf /", notify);
    expect(mgr.pendingCount).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.taskId).toBe("t1");
    expect(notices[0]!.message).toContain("rm -rf /");

    // 唤醒为允许
    const ok = mgr.resolveApproval("t1", true, "已批准");
    expect(ok).toBe(true);
    expect(mgr.pendingCount).toBe(0);

    const result = await promise;
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("已批准");
  });

  it("resolveApproval 唤醒为拒绝", async () => {
    const mgr = new ApprovalManager();
    const promise = mgr.waitForApproval("t2", "bash", "sudo rm", () => {});

    mgr.resolveApproval("t2", false, "危险操作已拒绝");
    const result = await promise;
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("危险操作已拒绝");
  });

  it("resolveApproval 对未知 TaskID 返回 false", () => {
    const mgr = new ApprovalManager();
    expect(mgr.resolveApproval("nonexistent", true, "")).toBe(false);
  });

  it("超时自动判 Reject,防协程泄漏", async () => {
    vi.useFakeTimers();
    const mgr = new ApprovalManager(1000); // 1 秒超时
    const promise = mgr.waitForApproval("t3", "bash", "rm -rf /", () => {});

    expect(mgr.pendingCount).toBe(1);
    vi.advanceTimersByTime(1001);

    const result = await promise;
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("超时");
    expect(mgr.pendingCount).toBe(0);
  });

  it("clear 清理所有挂起任务", () => {
    vi.useFakeTimers();
    const mgr = new ApprovalManager(60000);
    mgr.waitForApproval("a", "bash", "x", () => {});
    mgr.waitForApproval("b", "bash", "y", () => {});
    expect(mgr.pendingCount).toBe(2);
    mgr.clear();
    expect(mgr.pendingCount).toBe(0);
  });
});

describe("Registry Middleware 集成", () => {
  it("Middleware 放行:安全命令正常执行", async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    let approved = false;
    registry.use(async () => {
      approved = true;
      return { allowed: true, reason: "" };
    });

    const call: ToolCall = { id: "c1", name: "echo", arguments: '{"text":"hi"}' };
    const result = await registry.execute(call);
    expect(approved).toBe(true);
    expect(result.isError).toBe(false);
  });

  it("Middleware 拦截:高危命令返回 Error,不执行底层工具", async () => {
    const registry = new ToolRegistry();
    const ref = { executed: false };
    registry.register(fakeBashTool(ref));
    registry.use(async () => ({ allowed: false, reason: "高危命令已被拦截" }));

    const call: ToolCall = { id: "c1", name: "bash", arguments: '{"command":"rm -rf /"}' };
    const result = await registry.execute(call);
    expect(ref.executed).toBe(false); // 底层工具绝未执行
    expect(result.isError).toBe(true);
    expect(result.output).toContain("高危命令已被拦截");
    expect(result.output).toContain("执行被系统拦截");
  });

  it("多个 Middleware 链式调用:任一拒绝即拦截", async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const mw1 = async () => ({ allowed: true, reason: "" });
    const mw2 = async () => ({ allowed: false, reason: "第二个中间件拒绝" });
    const mw3 = async () => ({ allowed: true, reason: "" });
    registry.use(mw1);
    registry.use(mw2);
    registry.use(mw3);

    const result = await registry.execute({ id: "c1", name: "echo", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("第二个中间件拒绝");
  });

  it("审批 Middleware:approve 后放行执行", async () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const mgr = new ApprovalManager();
    registry.use(async (call) => {
      if (!isDangerousCommand(call.name, call.arguments)) {
        return { allowed: true, reason: "" };
      }
      const p = mgr.waitForApproval(call.id, call.name, call.arguments, () => {});
      // 立即批准
      mgr.resolveApproval(call.id, true, "已批准");
      return p;
    });

    // echo 不危险,直接放行
    const result = await registry.execute({ id: "c1", name: "echo", arguments: '{"text":"hi"}' });
    expect(result.isError).toBe(false);
  });

  it("审批 Middleware:reject 后返回拒绝 Error", async () => {
    const registry = new ToolRegistry();
    const ref = { executed: false };
    registry.register(fakeBashTool(ref));
    const mgr = new ApprovalManager();
    registry.use(async (call) => {
      if (!isDangerousCommand(call.name, call.arguments)) {
        return { allowed: true, reason: "" };
      }
      const p = mgr.waitForApproval(call.id, call.name, call.arguments, () => {});
      mgr.resolveApproval(call.id, false, "管理员拒绝");
      return p;
    });

    const result = await registry.execute({
      id: "c1",
      name: "bash",
      arguments: '{"command":"rm -rf /"}',
    });
    expect(ref.executed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("管理员拒绝");
  });
});
