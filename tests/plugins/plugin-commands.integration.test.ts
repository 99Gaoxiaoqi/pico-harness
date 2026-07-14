import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRegistry } from "../../src/input/command-registry.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { PluginManagementService } from "../../src/plugins/plugin-management-service.js";

describe("plugin slash commands", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("通过 /plugins 完成默认 project scope 的安装、信任、启用与停用", async () => {
    const fixture = await createFixture(cleanup);

    expect(await execute(fixture.registry, `/plugin install ${fixture.pluginDir}`)).toContain(
      "Installed plugin reviewer@1.0.0 to project",
    );
    expect(await execute(fixture.registry, "/plugins")).toContain(
      "reviewer [project] · disabled · trust pending",
    );
    expect(await execute(fixture.registry, "/plugin inspect reviewer")).toContain(
      "Manifest: pico-native",
    );
    expect(await execute(fixture.registry, "/plugin enable reviewer")).toContain("尚未信任");

    const proposal = await execute(fixture.registry, "/plugin trust reviewer");
    const confirmation = confirmationCommand(proposal);
    expect(confirmation).toMatch(
      /^\/plugin trust reviewer --scope project --confirm=[a-f0-9]{64} --fingerprint=[a-f0-9]{64}$/,
    );
    expect(await execute(fixture.registry, confirmation)).toContain("reviewer [project] trusted");
    expect(await execute(fixture.registry, "/plugin enable reviewer")).toContain(
      "reviewer [project] enabled",
    );
    expect(await execute(fixture.registry, "/plugins list --scope=project")).toContain(
      "reviewer [project] · active",
    );
    expect(await execute(fixture.registry, "/plugin disable reviewer")).toContain(
      "reviewer [project] disabled",
    );
  });

  it("显式 scope 只影响指定层级，非法 scope 被拒绝", async () => {
    const fixture = await createFixture(cleanup);

    await execute(fixture.registry, `/plugin install ${fixture.pluginDir} --scope user`);

    expect(await execute(fixture.registry, "/plugin list --scope user")).toContain(
      "reviewer [user] · disabled",
    );
    expect(await execute(fixture.registry, "/plugin list --scope project")).toBe(
      "No plugins installed in project scope.",
    );
    expect(await execute(fixture.registry, "/plugin inspect reviewer --scope=user")).toContain(
      "Plugin reviewer [user]",
    );
    expect(await execute(fixture.registry, "/plugin list --scope global")).toContain(
      "Invalid Plugin scope: global",
    );
  });

  it("确认参数必须匹配 pending proposal，且内容变化后拒绝旧确认", async () => {
    const fixture = await createFixture(cleanup);
    await execute(fixture.registry, `/plugin install ${fixture.pluginDir}`);

    const proposal = await execute(fixture.registry, "/plugin trust reviewer");
    const confirmation = confirmationCommand(proposal);
    const tampered = confirmation.replace(
      /--fingerprint=[a-f0-9]{64}/,
      `--fingerprint=${"0".repeat(64)}`,
    );
    expect(await execute(fixture.registry, tampered)).toContain(
      "Trust proposal or fingerprint does not match",
    );

    await writeFile(join(fixture.pluginDir, "skills", "review", "SKILL.md"), "changed\n");

    expect(await execute(fixture.registry, confirmation)).toContain("确认期间发生变化");
    expect(await execute(fixture.registry, "/plugin enable reviewer")).toContain("尚未信任");
    expect(await execute(fixture.registry, confirmation)).toContain("No pending trust proposal");
  });
});

async function createFixture(cleanup: string[]): Promise<{
  readonly pluginDir: string;
  readonly registry: CommandRegistry;
}> {
  const root = await mkdtemp(join(tmpdir(), "pico-plugin-command-"));
  cleanup.push(root);
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const pluginDir = join(root, "plugin");
  await mkdir(join(workDir), { recursive: true });
  await mkdir(join(pluginDir, ".pico"), { recursive: true });
  await mkdir(join(pluginDir, "skills", "review"), { recursive: true });
  await writeFile(
    join(pluginDir, ".pico", "plugin.json"),
    JSON.stringify({ name: "reviewer", version: "1.0.0" }),
  );
  await writeFile(
    join(pluginDir, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nReview carefully.\n",
  );
  const service = new PluginManagementService({ workDir, picoHome });
  const registry = await createPicoCommandRegistry({
    workDir,
    provider: "openai",
    model: "test-model",
    sessionId: `plugin-command:${root}`,
    pluginManagement: service,
  });
  return { pluginDir, registry };
}

async function execute(registry: CommandRegistry, input: string): Promise<string> {
  const processed = await processUserInput(input, { registry });
  if (processed.type !== "local-command") {
    throw new Error(`Expected local-command for ${input}, got ${processed.type}`);
  }
  return processed.result.message ?? "";
}

function confirmationCommand(output: string): string {
  const line = output.split("\n").find((item) => item.startsWith("Confirm: "));
  if (!line) throw new Error(`Missing confirmation command in:\n${output}`);
  return line.slice("Confirm: ".length);
}
