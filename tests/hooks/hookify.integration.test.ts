import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyHookifyProposal,
  createHookifyProposal,
  evaluateHookifyRules,
  loadHookifyRules,
} from "../../src/hooks/hookify/rules.js";

describe("Hookify restricted proposals", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-hookify-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("自然语言只编译为受限规则，完整 diff 被确认后原子写入", async () => {
    const proposal = createHookifyProposal({ workDir, description: "阻止 bash 删除生产库" });
    expect(proposal.rule).toMatchObject({
      event: "bash",
      action: "block",
      condition: { op: "regex" },
    });
    expect(proposal.diff).toContain("--- /dev/null");
    expect(proposal.diff).toContain(proposal.content.trim().split("\n")[0]);
    const confirm = vi.fn(() => true);
    const reloaded = vi.fn();
    expect(await applyHookifyProposal(proposal, { confirm, onApplied: reloaded })).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(reloaded).toHaveBeenCalledWith(proposal.targetPath);
    expect(await readFile(proposal.targetPath, "utf8")).toBe(proposal.content);

    const rules = await loadHookifyRules(workDir);
    expect(rules).toHaveLength(1);
    expect(
      evaluateHookifyRules(rules, "PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "drop database production" },
      }),
    ).toMatchObject({ decision: "deny" });
  });

  it("yolo 也不绕过 proposal 确认", async () => {
    const proposal = createHookifyProposal({
      workDir,
      description: "warn prompt containing 'secret'",
    });
    const confirm = vi.fn(() => false);
    expect(await applyHookifyProposal(proposal, { confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    await expect(readFile(proposal.targetPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
