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
      sandbox: { network: "deny" },
      lspServers: [],
      compatibility: {
        claude: {
          enabled: true,
          projectResources: true,
          userResources: true,
          modelAliases: {},
        },
      },
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
      sandbox: { network: "deny" },
      lspServers: [],
      compatibility: {
        claude: {
          enabled: true,
          projectResources: true,
          userResources: true,
          modelAliases: {},
        },
      },
    });
  });

  it("loads Claude compatibility switches and normalized model aliases", async () => {
    const workDir = await createConfig({
      compatibility: {
        claude: {
          enabled: true,
          projectResources: false,
          userResources: true,
          modelAliases: { Sonnet: "anthropic/claude-sonnet-4-5" },
        },
      },
    });

    await expect(loadPicoConfig(workDir)).resolves.toMatchObject({
      compatibility: {
        claude: {
          enabled: true,
          projectResources: false,
          userResources: true,
          modelAliases: { sonnet: "anthropic/claude-sonnet-4-5" },
        },
      },
    });
  });

  it.each([
    [{ version: 2 }, "version"],
    [{ commandsDir: "../outside" }, "commandsDir"],
    [{ permissions: { additionalDirectories: [42] } }, "permissions.additionalDirectories"],
    [{ keybindings: { Unknown: { x: "app:exit" } } }, "keybindings.Unknown"],
    [{ keybindings: { Chat: { x: "unknown:action" } } }, "keybindings.Chat.x"],
    [{ keybindings: { Chat: { x: "command:" } } }, "keybindings.Chat.x"],
    [{ compatibility: { claude: { enabled: "yes" } } }, "compatibility.claude.enabled"],
    [
      { compatibility: { claude: { modelAliases: { sonnet: "" } } } },
      "compatibility.claude.modelAliases.sonnet",
    ],
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
