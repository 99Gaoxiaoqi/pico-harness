import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPicoConfig } from "../../src/input/pico-config.js";

describe("loadPicoConfig", () => {
  it("returns stable defaults when .pico/config.json is absent", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-config-defaults-"));

    await expect(loadPicoConfig(workDir)).resolves.toEqual({
      version: 1,
      commandsDir: join(workDir, ".pico", "commands"),
      additionalDirectories: [],
      keybindings: {},
      providers: {},
    });
  });

  it("loads commands, permissions and normalized keybindings", async () => {
    const workDir = await createConfig({
      version: 1,
      commandsDir: "automation/commands",
      permissions: {
        additionalDirectories: [" ../shared ", "/absolute/shared"],
      },
      keybindings: {
        Chat: {
          "CTRL+M": "command:/model",
          "ctrl+a": null,
        },
        Confirmation: {
          y: "confirmation:accept",
        },
      },
      providers: {},
      futureField: true,
    });

    await expect(loadPicoConfig(workDir)).resolves.toEqual({
      version: 1,
      commandsDir: join(workDir, "automation", "commands"),
      additionalDirectories: ["../shared", "/absolute/shared"],
      keybindings: {
        Chat: {
          "ctrl+m": "command:/model",
          "ctrl+a": null,
        },
        Confirmation: {
          y: "confirmation:accept",
        },
      },
      providers: {},
    });
  });

  it.each([
    [{ version: 2 }, "version"],
    [{ commandsDir: "../outside" }, "commandsDir"],
    [{ permissions: { additionalDirectories: [42] } }, "permissions.additionalDirectories"],
    [{ keybindings: { Unknown: { x: "app:exit" } } }, "keybindings.Unknown"],
    [{ keybindings: { Chat: { x: "unknown:action" } } }, "keybindings.Chat.x"],
    [{ keybindings: { Chat: { x: "command:" } } }, "keybindings.Chat.x"],
  ])("rejects invalid known fields with a field path", async (config, fieldPath) => {
    const workDir = await createConfig(config);

    await expect(loadPicoConfig(workDir)).rejects.toThrow(fieldPath);
  });
});

async function createConfig(config: unknown): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "pico-config-"));
  await mkdir(join(workDir, ".pico"), { recursive: true });
  await writeFile(join(workDir, ".pico", "config.json"), JSON.stringify(config));
  return workDir;
}
