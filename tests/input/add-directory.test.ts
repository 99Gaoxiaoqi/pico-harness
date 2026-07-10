import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAddDirectoryCommand,
  loadConfiguredAdditionalDirectories,
  type AdditionalDirectoryManager,
} from "../../src/input/add-directory.js";
import { createDefaultSessionSettings } from "../../src/input/session-settings.js";

describe("add directory command", () => {
  it("loads permissions.additionalDirectories from project config", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-add-dir-config-"));
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "config.json"),
      JSON.stringify({
        permissions: { additionalDirectories: ["../shared", "/absolute/shared"] },
      }),
    );

    await expect(loadConfiguredAdditionalDirectories(workDir)).resolves.toEqual([
      "../shared",
      "/absolute/shared",
    ]);
  });

  it("returns no configured directories when project config is absent", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-add-dir-no-config-"));
    await expect(loadConfiguredAdditionalDirectories(workDir)).resolves.toEqual([]);
  });

  it("lists the currently authorized workspace roots without arguments", async () => {
    const manager: AdditionalDirectoryManager = {
      list: () => ["/workspace/app", "/workspace/shared"],
      addDirectory: vi.fn(),
    };
    const command = createAddDirectoryCommand(createSettings(), manager);

    const result = await command.execute(
      { raw: "/add-dir", name: "add-dir", args: "", argv: [] },
      {},
    );

    expect(result).toMatchObject({ type: "local", action: "message" });
    expect(result.type === "local" ? result.message : undefined).toContain("/workspace/app");
    expect(result.type === "local" ? result.message : undefined).toContain("/workspace/shared");
  });

  it("passes the raw argument through and synchronizes the canonical path", async () => {
    const addDirectory = vi.fn(async (path: string) => ({
      added: true,
      path: `/canonical/${path.slice(1)}`,
    }));
    const manager: AdditionalDirectoryManager = {
      list: () => ["/workspace/app"],
      addDirectory,
    };
    const settings = createSettings();
    const command = createAddDirectoryCommand(settings, manager);

    const result = await command.execute(
      {
        raw: "/add-dir /outside/path with spaces",
        name: "add-dir",
        args: "/outside/path with spaces",
        argv: ["/outside/path", "with", "spaces"],
      },
      {},
    );

    expect(addDirectory).toHaveBeenCalledWith("/outside/path with spaces");
    expect(settings.additionalDirectories).toEqual(["/canonical/outside/path with spaces"]);
    expect(result.type === "local" ? result.message : undefined).toContain(
      "/canonical/outside/path with spaces",
    );
  });

  it("presents manager rejections without changing session settings", async () => {
    const manager: AdditionalDirectoryManager = {
      list: () => ["/workspace/app"],
      addDirectory: async (path) => ({
        added: false,
        path,
        reason: "Directory is already authorized.",
      }),
    };
    const settings = createSettings();
    const command = createAddDirectoryCommand(settings, manager);

    const result = await command.execute(
      { raw: "/add-dir /workspace/app", name: "add-dir", args: "/workspace/app", argv: [] },
      {},
    );

    expect(settings.additionalDirectories).toEqual([]);
    expect(result.type === "local" ? result.message : undefined).toContain(
      "Directory is already authorized.",
    );
  });

  it("presents thrown manager errors as a friendly local message", async () => {
    const manager: AdditionalDirectoryManager = {
      list: () => ["/workspace/app"],
      addDirectory: async () => {
        throw new Error("Directory does not exist.");
      },
    };
    const command = createAddDirectoryCommand(createSettings(), manager);

    const result = await command.execute(
      { raw: "/add-dir /missing", name: "add-dir", args: "/missing", argv: [] },
      {},
    );

    expect(result.type === "local" ? result.message : undefined).toContain(
      "Directory does not exist.",
    );
  });

  it("remains callable when no directory manager was provided", async () => {
    const command = createAddDirectoryCommand(createSettings());

    const result = await command.execute(
      { raw: "/add-dir /outside", name: "add-dir", args: "/outside", argv: [] },
      {},
    );

    expect(result).toMatchObject({ type: "local", action: "message" });
    expect(result.type === "local" ? result.message : undefined).toContain("unavailable");
  });
});

function createSettings() {
  return createDefaultSessionSettings({
    sessionId: "add-directory-test",
    cwd: "/workspace/app",
    provider: "openai",
    model: "glm-5.2",
  });
}
