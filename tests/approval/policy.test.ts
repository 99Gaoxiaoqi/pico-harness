import { describe, it, expect, beforeEach } from "vitest";
import {
  PermissionManager,
  DangerousCommandPolicy,
  SensitiveFilePolicy,
  GitDirectoryPolicy,
  PlanModeGuardPolicy,
  SessionApprovalPolicy,
  type PolicyContext,
} from "../../src/approval/policy.js";
import type { ToolCall } from "../../src/schema/message.js";

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: "call_1", name, arguments: JSON.stringify(args) };
}

function makeCtx(
  toolCall: ToolCall,
  overrides: Partial<PolicyContext> = {},
): PolicyContext {
  return {
    toolCall,
    workDir: "/project",
    planMode: false,
    sessionApprovals: new Set<string>(),
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────
// DangerousCommandPolicy
// ──────────────────────────────────────────────────────────────

describe("DangerousCommandPolicy", () => {
  const policy = new DangerousCommandPolicy();

  it("rm -rf / → deny (hardline)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "rm -rf /" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("mkfs /dev/sda → deny (hardline)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "mkfs.ext4 /dev/sda1" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("shutdown → deny (hardline)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "shutdown -h now" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("git push --force origin main → deny (hardline)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "git push --force origin main" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("rm file.txt → ask (dangerous but not hardline)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "rm file.txt" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("sudo apt update → ask", () => {
    const ctx = makeCtx(makeCall("bash", { command: "sudo apt update" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("git push --force origin feature → ask (force but not main)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "git push --force origin feature-x" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("ls -la → allow", () => {
    const ctx = makeCtx(makeCall("bash", { command: "ls -la" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("echo hello → allow", () => {
    const ctx = makeCtx(makeCall("bash", { command: "echo hello" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("read_file → allow (not a dangerous tool)", () => {
    const ctx = makeCtx(makeCall("read_file", { path: "src/a.ts" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });
});

// ──────────────────────────────────────────────────────────────
// SensitiveFilePolicy
// ──────────────────────────────────────────────────────────────

describe("SensitiveFilePolicy", () => {
  const policy = new SensitiveFilePolicy();

  it("write .env → ask", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".env", content: "KEY=val" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("敏感文件");
  });

  it("write .env.example → allow (exempt)", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".env.example", content: "KEY=val" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("write .env.local → ask", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".env.local", content: "KEY=val" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("read id_rsa → ask", () => {
    const ctx = makeCtx(makeCall("read_file", { path: "~/.ssh/id_rsa" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("read id_rsa.pub → allow (exempt)", () => {
    const ctx = makeCtx(makeCall("read_file", { path: "~/.ssh/id_rsa.pub" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("write .aws/credentials → ask", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".aws/credentials", content: "..." }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("write src/utils.ts → allow (not sensitive)", () => {
    const ctx = makeCtx(makeCall("write_file", { path: "src/utils.ts", content: "..." }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("edit config/key.pem → ask", () => {
    const ctx = makeCtx(makeCall("edit_file", { path: "config/key.pem", old_text: "a", new_text: "b" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("bash command → allow (can't static analyze path)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "cat .env" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });
});

// ──────────────────────────────────────────────────────────────
// GitDirectoryPolicy
// ──────────────────────────────────────────────────────────────

describe("GitDirectoryPolicy", () => {
  const policy = new GitDirectoryPolicy();

  it("write .git/config → ask", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".git/config", content: "..." }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
    expect(result.reason).toContain("Git 目录保护");
  });

  it("edit .git/HEAD → ask", () => {
    const ctx = makeCtx(makeCall("edit_file", { path: ".git/HEAD", old_text: "a", new_text: "b" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("write src/app.ts → allow (not in .git)", () => {
    const ctx = makeCtx(makeCall("write_file", { path: "src/app.ts", content: "..." }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("bash rm .git/refs → ask", () => {
    const ctx = makeCtx(makeCall("bash", { command: "rm -rf .git/refs" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("read_file .git/config → allow (read is safe)", () => {
    const ctx = makeCtx(makeCall("read_file", { path: ".git/config" }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });
});

// ──────────────────────────────────────────────────────────────
// PlanModeGuardPolicy
// ──────────────────────────────────────────────────────────────

describe("PlanModeGuardPolicy", () => {
  const policy = new PlanModeGuardPolicy();

  it("planMode + write src/a.ts → deny", () => {
    const ctx = makeCtx(
      makeCall("write_file", { path: "src/a.ts", content: "..." }),
      { planMode: true },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Plan Mode");
  });

  it("planMode + write PLAN.md → allow", () => {
    const ctx = makeCtx(
      makeCall("write_file", { path: "PLAN.md", content: "# Plan" }),
      { planMode: true },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("planMode + edit TODO.md → allow", () => {
    const ctx = makeCtx(
      makeCall("edit_file", { path: "TODO.md", old_text: "a", new_text: "b" }),
      { planMode: true },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("not planMode + write src/a.ts → allow", () => {
    const ctx = makeCtx(
      makeCall("write_file", { path: "src/a.ts", content: "..." }),
      { planMode: false },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("planMode + bash echo > src/a.ts → deny", () => {
    const ctx = makeCtx(
      makeCall("bash", { command: "echo hello > src/a.ts" }),
      { planMode: true },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("planMode + bash echo > PLAN.md → allow", () => {
    const ctx = makeCtx(
      makeCall("bash", { command: "echo '# Plan' > PLAN.md" }),
      { planMode: true },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });
});

// ──────────────────────────────────────────────────────────────
// SessionApprovalPolicy
// ──────────────────────────────────────────────────────────────

describe("SessionApprovalPolicy", () => {
  const policy = new SessionApprovalPolicy();

  it("no prior approval → allow (passthrough)", () => {
    const ctx = makeCtx(makeCall("write_file", { path: "src/a.ts", content: "..." }));
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("prior approval for same tool+path → allow with reason", () => {
    const ctx = makeCtx(
      makeCall("write_file", { path: "src/a.ts", content: "..." }),
      { sessionApprovals: new Set(["write_file:src/a.ts"]) },
    );
    const result = policy.evaluate(ctx);
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("Session 审批记忆");
  });
});

// ──────────────────────────────────────────────────────────────
// PermissionManager（完整 Policy 链）
// ──────────────────────────────────────────────────────────────

describe("PermissionManager", () => {
  let manager: PermissionManager;

  beforeEach(() => {
    manager = new PermissionManager();
  });

  it("safe command → allow", () => {
    const ctx = makeCtx(makeCall("bash", { command: "ls -la" }));
    const result = manager.evaluate(ctx);
    expect(result.decision).toBe("allow");
  });

  it("dangerous command → ask", () => {
    const ctx = makeCtx(makeCall("bash", { command: "rm file.txt" }));
    const result = manager.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("hardline command → deny (overrides everything)", () => {
    const ctx = makeCtx(makeCall("bash", { command: "rm -rf /" }));
    const result = manager.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("sensitive file → ask", () => {
    const ctx = makeCtx(makeCall("write_file", { path: ".env", content: "KEY=val" }));
    const result = manager.evaluate(ctx);
    expect(result.decision).toBe("ask");
  });

  it("planMode + write non-plan file → deny (overrides sensitive)", () => {
    const ctx = makeCtx(
      makeCall("write_file", { path: "src/a.ts", content: "..." }),
      { planMode: true },
    );
    const result = manager.evaluate(ctx);
    expect(result.decision).toBe("deny");
  });

  it("session approval → allow (short-circuits dangerous)", () => {
    // bash 的 key 格式是 toolName:arguments.slice(0,50)
    // arguments 是 JSON 字符串 '{"command":"rm file.txt"}'
    const call = makeCall("bash", { command: "rm file.txt" });
    const key = `bash:${call.arguments.slice(0, 50)}`;
    const ctx = makeCtx(call, {
      sessionApprovals: new Set([key]),
    });
    const result = manager.evaluate(ctx);
    // SessionApproval is first in chain, should allow
    expect(result.decision).toBe("allow");
  });

  it("rememberApproval → subsequent calls allowed", () => {
    const call = makeCall("write_file", { path: "src/a.ts", content: "..." });

    // First call: no approval → allow (not dangerous, not sensitive)
    const ctx1 = makeCtx(call);
    expect(manager.evaluate(ctx1).decision).toBe("allow");

    // Remember approval
    manager.rememberApproval(call);

    // Second call: has approval → allow with reason
    const ctx2 = makeCtx(call, {
      sessionApprovals: manager.sessionApprovals,
    });
    const result = manager.evaluate(ctx2);
    expect(result.decision).toBe("allow");
  });

  it("clearApprovals → clears all memories", () => {
    const call = makeCall("write_file", { path: "src/a.ts", content: "..." });
    manager.rememberApproval(call);
    expect(manager.sessionApprovals.size).toBe(1);

    manager.clearApprovals();
    expect(manager.sessionApprovals.size).toBe(0);
  });
});
