import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const macSigningIdentity = process.env.PICO_MAC_SIGN_IDENTITY;
const appleId = process.env.PICO_APPLE_ID;
const appleIdPassword = process.env.PICO_APPLE_ID_PASSWORD;
const appleTeamId = process.env.PICO_APPLE_TEAM_ID;
const updateBaseUrl = readOptionalHttpsUrl("PICO_UPDATE_BASE_URL");
const workspaceRoot = resolve(import.meta.dirname, "../..");
const nativeRuntimePackages = ["better-sqlite3", "bindings", "file-uri-to-path"] as const;

const macNotarization =
  appleId && appleIdPassword && appleTeamId
    ? { appleId, appleIdPassword, teamId: appleTeamId }
    : undefined;

const config = {
  packagerConfig: {
    appBundleId: "com.pico.harness",
    appCategoryType: "public.app-category.developer-tools",
    asar: { unpack: "**/*.node" },
    executableName: "Pico",
    name: "Pico",
    osxSign: macSigningIdentity ? { identity: macSigningIdentity } : undefined,
    osxNotarize: macNotarization,
  },
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const target = join(buildPath, "node_modules");
      await mkdir(target, { recursive: true });
      for (const packageName of nativeRuntimePackages) {
        await cp(join(workspaceRoot, "node_modules", packageName), join(target, packageName), {
          recursive: true,
        });
      }
    },
  },
  rebuildConfig: { force: true },
  makers: [
    new MakerZIP(updateBaseUrl ? { macUpdateManifestBaseUrl: `${updateBaseUrl}/darwin` } : {}, [
      "darwin",
    ]),
    new MakerDMG(
      {
        name: "Pico",
        overwrite: true,
      },
      ["darwin"],
    ),
    new MakerSquirrel(
      {
        authors: "Pico",
        description: "Pico Agent Harness desktop application",
        exe: "Pico.exe",
        name: "pico",
        setupExe: "PicoSetup.exe",
        ...(updateBaseUrl ? { remoteReleases: `${updateBaseUrl}/win32` } : {}),
      },
      ["win32"],
    ),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
  ],
} satisfies ForgeConfig;

export default config;

function readOptionalHttpsUrl(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("must use HTTPS");
    return url.toString().replace(/\/$/u, "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be a valid HTTPS URL: ${reason}`, { cause: error });
  }
}
