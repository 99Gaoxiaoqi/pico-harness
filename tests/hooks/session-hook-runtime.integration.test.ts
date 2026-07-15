import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { HookLocalStateStore } from "../../src/hooks/management/state.js";
import { createSessionHookRuntime } from "../../src/hooks/runtime.js";
import { HookTrustStore } from "../../src/hooks/trust/store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

describe("SessionHookRuntime integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("host-owned PICO_HOME isolates Hook config, trust and local enabled state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-hook-profile-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const hostPicoHome = join(root, "host-home");
    const processPicoHome = join(root, "process-home");
    await Promise.all([
      mkdir(join(workDir, ".pico"), { recursive: true }),
      mkdir(hostPicoHome, { recursive: true }),
      mkdir(processPicoHome, { recursive: true }),
    ]);
    await writeFile(
      join(workDir, ".pico", "hooks.json"),
      JSON.stringify({
        PreToolUse: [
          { matcher: "bash", hooks: [{ type: "command", command: "echo profile-check" }] },
        ],
      }),
    );

    const processSnapshot = await loadHookSnapshot({
      workDir,
      picoHome: processPicoHome,
    });
    const processEntry = processSnapshot.snapshot.handlers.PreToolUse[0];
    if (!processEntry) throw new Error("expected the project Hook fixture to load");
    await new HookTrustStore({ picoHome: processPicoHome }).trustResolved(workDir, processEntry);
    await new HookLocalStateStore(workDir, { picoHome: processPicoHome }).set(
      processEntry.id,
      false,
    );

    const previousPicoHome = process.env.PICO_HOME;
    process.env.PICO_HOME = processPicoHome;
    const runtime = await createSessionHookRuntime({
      workDir,
      picoHome: hostPicoHome,
      env: { PICO_HOME: hostPicoHome },
      sessionId: "host-profile",
    });
    try {
      expect(runtime.management.list()).toEqual([
        expect.objectContaining({ id: processEntry.id, status: "pending" }),
      ]);

      await runtime.management.trust(processEntry.id);
      expect(runtime.management.list()).toEqual([
        expect.objectContaining({ id: processEntry.id, status: "active" }),
      ]);

      await runtime.management.disable(processEntry.id);
      expect(runtime.management.list()).toEqual([
        expect.objectContaining({ id: processEntry.id, status: "disabled" }),
      ]);
      await expect(access(join(hostPicoHome, "trusted-hooks.json"))).resolves.toBeUndefined();
      await expect(
        access(resolvePicoPaths(workDir, { picoHome: hostPicoHome }).workspace.hookState),
      ).resolves.toBeUndefined();
    } finally {
      await runtime.dispose();
      if (previousPicoHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = previousPicoHome;
    }
  });

  it("/hookify 先展示完整 diff，显式 confirm 后无重启阻断下一次 bash", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-session-hooks-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([mkdir(workDir, { recursive: true }), mkdir(userHome, { recursive: true })]);
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

  it("Skill/Agent component source 只在激活租约期间进入快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-component-hooks-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([mkdir(workDir, { recursive: true }), mkdir(userHome, { recursive: true })]);
    const runtime = await createSessionHookRuntime({ workDir, userHome, sessionId: "component" });
    try {
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(0);
      const deactivate = await runtime.activateComponentSource({
        kind: "skill",
        path: join(workDir, ".claude", "skills", "guard", "SKILL.md"),
        componentId: "guard",
        inlineHooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [{ type: "prompt", prompt: "Check command" }],
            },
          ],
        },
      });
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(1);
      expect(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.source).toMatchObject({
        kind: "skill",
        componentId: "guard",
      });
      await deactivate();
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("受信 Plugin Hook 在会话启动时作为扩展来源加载", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-plugin-hooks-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([mkdir(workDir, { recursive: true }), mkdir(userHome, { recursive: true })]);
    const runtime = await createSessionHookRuntime({
      workDir,
      userHome,
      sessionId: "plugin-hooks",
      extensionSources: [
        {
          kind: "plugin",
          path: join(root, "plugins", "guard", "hooks.json"),
          componentId: "guard",
          inlineHooks: {
            PreToolUse: [
              { matcher: "bash", hooks: [{ type: "command", command: "echo checked" }] },
            ],
          },
        },
      ],
    });
    try {
      expect(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.source).toMatchObject({
        kind: "plugin",
        componentId: "guard",
      });
      expect(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("并发组件租约独立释放，不会覆盖仍活跃的 Hook source", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-component-hooks-concurrent-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([mkdir(workDir, { recursive: true }), mkdir(userHome, { recursive: true })]);
    const runtime = await createSessionHookRuntime({
      workDir,
      userHome,
      sessionId: "component-race",
    });
    const source = (componentId: string) => ({
      kind: "skill" as const,
      path: join(workDir, ".claude", "skills", componentId, "SKILL.md"),
      componentId,
      inlineHooks: {
        PreToolUse: [
          {
            matcher: "bash",
            hooks: [{ type: "prompt" as const, prompt: `Check ${componentId}` }],
          },
        ],
      },
    });
    try {
      const [deactivateA, deactivateB] = await Promise.all([
        runtime.activateComponentSource(source("guard-a")),
        runtime.activateComponentSource(source("guard-b")),
      ]);
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(2);

      await deactivateA();
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(1);
      expect(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.source).toMatchObject({
        componentId: "guard-b",
      });

      await deactivateB();
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("组件自身的 ConfigChange deny 不会阻断最后一个租约退租", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-component-self-guard-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    await Promise.all([mkdir(workDir, { recursive: true }), mkdir(userHome, { recursive: true })]);
    const runtime = await createSessionHookRuntime({ workDir, userHome, sessionId: "self-guard" });
    runtime.bind({
      provider: {
        async generate() {
          return { role: "assistant", content: '{"ok":false,"reason":"keep me"}' };
        },
      },
    });
    try {
      const deactivate = await runtime.activateComponentSource({
        kind: "skill",
        path: join(workDir, ".claude", "skills", "self-guard", "SKILL.md"),
        componentId: "self-guard",
        inlineHooks: {
          ConfigChange: [{ hooks: [{ type: "prompt", prompt: "deny retirement" }] }],
        },
      });
      expect(runtime.service.currentSnapshot().handlers.ConfigChange).toHaveLength(1);

      await deactivate();

      expect(runtime.service.currentSnapshot().handlers.ConfigChange).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("组件退租不会绕过同期静态 ConfigChange 守卫", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-component-static-guard-"));
    cleanup.push(root);
    const workDir = join(root, "workspace");
    const userHome = join(root, "home");
    const configPath = join(workDir, ".pico", "hooks.json");
    await Promise.all([
      mkdir(join(workDir, ".pico"), { recursive: true }),
      mkdir(userHome, { recursive: true }),
    ]);
    const config = (prompt: string) =>
      JSON.stringify({ ConfigChange: [{ hooks: [{ type: "prompt", prompt }] }] });
    await writeFile(configPath, config("old static guard"));
    let allowConfigChange = true;
    const runtime = await createSessionHookRuntime({
      workDir,
      userHome,
      sessionId: "static-guard",
    });
    runtime.bind({
      provider: {
        async generate() {
          return {
            role: "assistant",
            content: JSON.stringify({ ok: allowConfigChange, reason: "static guard" }),
          };
        },
      },
    });
    try {
      const deactivate = await runtime.activateComponentSource({
        kind: "skill",
        path: join(workDir, ".claude", "skills", "temporary", "SKILL.md"),
        componentId: "temporary",
        inlineHooks: {
          PreToolUse: [{ matcher: "bash", hooks: [{ type: "prompt", prompt: "temporary" }] }],
        },
      });
      expect(runtime.service.currentSnapshot().handlers.PreToolUse).toHaveLength(1);

      allowConfigChange = false;
      await writeFile(configPath, config("unaccepted static guard"));
      await deactivate();

      const snapshot = runtime.service.currentSnapshot();
      expect(snapshot.handlers.PreToolUse).toHaveLength(0);
      expect(snapshot.handlers.ConfigChange[0]?.handler).toMatchObject({
        type: "prompt",
        prompt: "old static guard",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
