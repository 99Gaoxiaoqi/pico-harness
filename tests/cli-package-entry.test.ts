import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(projectRoot, path), "utf8")) as Record<string, unknown>;
}

describe("installable CLI package entry", () => {
  it("package scripts 使用独立 build config，并在 prepack 时执行发布物 smoke", async () => {
    const pkg = await readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;

    expect(pkg.bin).toEqual({ pico: "./dist/cli/main.js" });
    expect(scripts.clean).toContain("dist");
    expect(scripts.build).toBe("tsc -p tsconfig.build.json");
    expect(scripts.prebuild).toBe("npm run clean && npm run build:protocol");
    expect(scripts.prepack).toBe("npm run build && npm run smoke:package");
    expect(scripts["smoke:package"]).toBe(
      "node scripts/package-bin-smoke.mjs && node scripts/package-install-smoke.mjs",
    );
  });

  it("build config 把 src 直接编译到 dist，不产生 dist/src 层", async () => {
    const config = await readJson("tsconfig.build.json");
    const compilerOptions = config.compilerOptions as Record<string, unknown>;

    expect(config.extends).toBe("./tsconfig.json");
    expect(compilerOptions.rootDir).toBe("src");
    expect(compilerOptions.outDir).toBe("dist");
    expect(config.include).toEqual(["src/**/*.ts", "src/**/*.tsx"]);
  });

  it("发布入口保留 shebang", async () => {
    const source = await readFile(join(projectRoot, "src/cli/main.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("只保留可用的 Windows TUI 启动脚本", async () => {
    const tuiLauncher = await readFile(join(projectRoot, "启动TUI.bat"), "utf8");
    expect(tuiLauncher).toContain("src/cli/main.ts");
    expect(tuiLauncher).not.toContain("--tui");

    for (const retired of [
      "启动TUI-安静模式.bat",
      "启动CLI.bat",
      "单次任务.bat",
      "启动HTTP服务.bat",
      "启动ACP-IDE桥接.bat",
      "Dockerfile",
      "docker-compose.yml",
    ]) {
      await expect(access(join(projectRoot, retired), constants.F_OK)).rejects.toThrow();
    }
  });
});
