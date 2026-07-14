import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResourceDoctor } from "../src/diagnostics/resource-doctor.js";

describe("ResourceDoctor", () => {
  it("只读展示 Pico/Claude 来源并选择 Pico 原生 authority", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-resource-doctor-work-"));
    const homeDir = await mkdtemp(join(tmpdir(), "pico-resource-doctor-user-"));
    const picoHome = join(homeDir, "pico-home");
    await mkdir(join(workDir, ".pico", "skills"), { recursive: true });
    await mkdir(join(workDir, ".claude", "skills"), { recursive: true });
    await writeFile(join(workDir, ".pico", "agents.yaml"), "agents: []\n");

    const report = await new ResourceDoctor({ workDir, homeDir, picoHome }).scan();
    const skills = report.entries.filter((entry) => entry.kind === "skills");

    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ origin: "pico-native", status: "present", authority: true }),
        expect.objectContaining({ origin: "claude-compat", status: "present", authority: false }),
      ]),
    );
    expect(report.picoHome).toBe(picoHome);
  });

  it("发现 legacy .claw 时报告迁移提示但不修改目录", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-resource-doctor-legacy-"));
    const homeDir = await mkdtemp(join(tmpdir(), "pico-resource-doctor-home-"));
    await mkdir(join(workDir, ".claw"));

    const report = await new ResourceDoctor({ workDir, homeDir }).scan();

    expect(report.findings).toContain("检测到 legacy .claw，运行迁移前保持只读兼容。");
  });
});
