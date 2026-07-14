import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";

const macSigningIdentity = process.env.PICO_MAC_SIGN_IDENTITY;
const appleId = process.env.PICO_APPLE_ID;
const appleIdPassword = process.env.PICO_APPLE_ID_PASSWORD;
const appleTeamId = process.env.PICO_APPLE_TEAM_ID;
const updateBaseUrl = process.env.PICO_UPDATE_BASE_URL?.replace(/\/$/u, "");

const macNotarization =
  appleId && appleIdPassword && appleTeamId
    ? { appleId, appleIdPassword, teamId: appleTeamId }
    : undefined;

const config = {
  packagerConfig: {
    appBundleId: "com.pico.harness",
    appCategoryType: "public.app-category.developer-tools",
    asar: true,
    executableName: "Pico",
    name: "Pico",
    osxSign: macSigningIdentity ? { identity: macSigningIdentity } : undefined,
    osxNotarize: macNotarization,
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP(
      updateBaseUrl ? { macUpdateManifestBaseUrl: `${updateBaseUrl}/darwin` } : {},
      ["darwin"],
    ),
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
