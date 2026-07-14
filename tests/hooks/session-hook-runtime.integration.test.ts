import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionHookRuntime } from "../../src/hooks/runtime.js";

describe("SessionHookRuntime integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("/hookify 先展示完整 diff，显式 confirm 后无重启阻断下一次 bash", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-hooks-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([
      mkdir(workDir, { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    const runtime = await createSessionHookRuntime({
      workDir,
      userHome,
      sessionId: "session-hookify",
    });
    try {
      const hookify = runtime.commands.find((command) => command.name === "hookify");
      expect(hookify).toBeDefined();

      const proposed = await hookify!.execute(
        {
          raw: "/hookify 阻止 bash 删除生产库",
          name: "hookify",
          args: "阻止 bash 删除生产库",
          argv: ["阻止", "bash", "删除生产库"],
        },
        {},
      );
      expect(proposed).toMatchObject({ type: "local", action: "message" });
      expect("message" in proposed ? proposed.message : "").toContain("+++ ");
      const proposal = "data" in proposed ? (proposed.data as { targetPath: string }) : undefined;
      expect(proposal).toBeDefined();
      await expect(access(proposal!.targetPath)).rejects.toMatchObject({ code: "ENOENT" });

      const confirmed = await hookify!.execute(
        {
          raw: "/hookify confirm",
          name: "hookify",
          args: "confirm",
          argv: ["confirm"],
        },
        {},
      );
      expect("message" in confirmed ? confirmed.message : "").toContain("applied");
      expect(await readFile(proposal!.targetPath, "utf8")).toContain("action: block");

      await expect(
        runtime.service.dispatch("PreToolUse", {
          tool_name: "bash",
          tool_input: { command: "rm -rf /prod/database" },
        }),
      ).resolves.toMatchObject({ decision: "deny" });
    } finally {
      await runtime.dispose();
    }
  });
});
