import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginManagementService } from "../../src/plugins/plugin-management-service.js";

describe("PluginManagementService", () => {
  it("安装后保持 disabled，显式信任后才允许 enable", async () => {
    const fixture = await createFixture();
    await fixture.service.install(fixture.pluginDir, "project");

    await expect(fixture.service.enable({ id: "reviewer", scope: "project" })).rejects.toThrow(
      "尚未信任",
    );
    const proposal = await fixture.service.prepareTrust({ id: "reviewer", scope: "project" });
    await fixture.service.trust(proposal);
    await fixture.service.enable({ id: "reviewer", scope: "project" });

    expect((await fixture.service.activeContributions()).map((item) => item.plugin.id)).toEqual([
      "reviewer",
    ]);
  });

  it("资源变化后旧信任与 enabled 状态不能激活 Plugin", async () => {
    const fixture = await createFixture();
    await fixture.service.install(fixture.pluginDir, "project");
    const proposal = await fixture.service.prepareTrust({ id: "reviewer", scope: "project" });
    await fixture.service.trust(proposal);
    await fixture.service.enable({ id: "reviewer", scope: "project" });

    await writeFile(join(fixture.pluginDir, "skills", "review", "SKILL.md"), "changed\n");

    const inspection = await fixture.service.inspect({ id: "reviewer", scope: "project" });
    expect(inspection).toMatchObject({ trust: "pending", changedSinceInstall: true, active: false });
    expect(await fixture.service.activeContributions()).toEqual([]);
  });

  it("确认期间内容变化时拒绝提交旧 proposal", async () => {
    const fixture = await createFixture();
    await fixture.service.install(fixture.pluginDir, "project");
    const proposal = await fixture.service.prepareTrust({ id: "reviewer", scope: "project" });
    await writeFile(join(fixture.pluginDir, "extra.txt"), "changed");

    await expect(fixture.service.trust(proposal)).rejects.toThrow("确认期间发生变化");
  });
});

async function createFixture(): Promise<{
  pluginDir: string;
  service: PluginManagementService;
}> {
  const workDir = await mkdtemp(join(tmpdir(), "pico-plugin-management-work-"));
  const picoHome = await mkdtemp(join(tmpdir(), "pico-plugin-management-home-"));
  const pluginDir = await mkdtemp(join(tmpdir(), "pico-plugin-management-source-"));
  await mkdir(join(pluginDir, ".claude-plugin"));
  await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
  await writeFile(
    join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "reviewer", version: "1.0.0" }),
  );
  await writeFile(
    join(pluginDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nReview carefully.\n",
  );
  return {
    pluginDir,
    service: new PluginManagementService({ workDir, picoHome }),
  };
}
