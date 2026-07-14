import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHookSnapshot, type LoadHookSnapshotResult } from "../../src/hooks/config.js";
import { HookConfigReloader } from "../../src/hooks/config/reloader.js";
import { HookManagementService } from "../../src/hooks/management/service.js";
import { HookLocalStateStore } from "../../src/hooks/management/state.js";
import { HookTrustStore } from "../../src/hooks/trust/store.js";

describe("Hook reload and management", () => {
  let root: string;
  let workDir: string;
  let userHome: string;
  let configPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pico-hook-reload-"));
    workDir = join(root, "workspace");
    userHome = join(root, "home");
    configPath = join(workDir, ".claw", "hooks.local.json");
    await mkdir(join(workDir, ".claw"), { recursive: true });
    await mkdir(join(userHome, ".pico"), { recursive: true });
    await writeFile(configPath, canonicalCommand("echo first"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("解析失败或旧 snapshot ConfigChange deny 时保留旧运行快照", async () => {
    let active = await loadHookSnapshot({ workDir, userHome });
    const swapped = vi.fn((result: LoadHookSnapshotResult) => {
      active = result;
    });
    let allow = true;
    const reloader = new HookConfigReloader({
      workDir,
      userHome,
      initial: active,
      beforeSwap: ({ oldSnapshot }) => {
        expect(oldSnapshot.id).toBe(active.snapshot.id);
        return allow;
      },
      onSwap: swapped,
    });
    await reloader.start();
    await writeFile(configPath, "{");
    expect(await reloader.reload([configPath])).toBe(false);
    expect(swapped).not.toHaveBeenCalled();

    await writeFile(configPath, canonicalCommand("echo denied"));
    allow = false;
    expect(await reloader.reload([configPath])).toBe(false);
    expect(swapped).not.toHaveBeenCalled();

    allow = true;
    expect(await reloader.reload([configPath])).toBe(true);
    expect(active.snapshot.handlers.PreToolUse[0]?.handler).toMatchObject({
      command: "echo denied",
    });
    reloader.stop();
  });

  it("管理 API 仅按 id trust/disable/enable/reload", async () => {
    const trustStore = new HookTrustStore({ userHome });
    const stateStore = new HookLocalStateStore(workDir);
    let active = await loadHookSnapshot({ workDir, userHome, trustStore, stateStore });
    const reload = async () => {
      active = await loadHookSnapshot({
        workDir,
        userHome,
        trustStore,
        stateStore,
        version: active.snapshot.version + 1,
      });
      return true;
    };
    const management = new HookManagementService({
      workDir,
      currentSnapshot: () => active.snapshot,
      reload,
      trustStore,
      stateStore,
    });
    const id = management.list()[0]!.id;
    expect(management.list()[0]?.status).toBe("pending");
    await management.trust(id);
    expect(management.list()[0]?.status).toBe("active");
    await management.disable(id);
    expect(management.list()[0]?.status).toBe("disabled");
    await management.enable(id);
    expect(management.list()[0]?.status).toBe("active");
    await expect(management.review("command:deadbeef")).rejects.toThrow("不存在");
  });
});

function canonicalCommand(command: string): string {
  return JSON.stringify({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
  });
}
