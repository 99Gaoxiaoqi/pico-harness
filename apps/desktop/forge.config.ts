import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { join } from "node:path";

import { MakerHdiutilDmg } from "./makers/hdiutil-dmg.js";
import { sandboxPackageHooks } from "./sandbox-package-hooks.js";

const macSigningIdentity = process.env.PICO_MAC_SIGN_IDENTITY;
const appleId = process.env.PICO_APPLE_ID;
const appleIdPassword = process.env.PICO_APPLE_ID_PASSWORD;
const appleTeamId = process.env.PICO_APPLE_TEAM_ID;
const updateBaseUrl = readOptionalHttpsUrl("PICO_UPDATE_BASE_URL");
const desktopAssetPath = (...segments: string[]): string =>
  join(import.meta.dirname, "assets", ...segments);
const desktopPackageIcon = desktopAssetPath(
  process.platform === "darwin"
    ? "icon.icns"
    : process.platform === "win32"
      ? "icon.ico"
      : "icon.png",
);

const macNotarization =
  appleId && appleIdPassword && appleTeamId
    ? { appleId, appleIdPassword, teamId: appleTeamId }
    : undefined;

const config = {
  hooks: sandboxPackageHooks(
    join(import.meta.dirname, "../../resources/sandbox"),
    join(import.meta.dirname, "out"),
  ),
  packagerConfig: {
    appBundleId: "com.pico.harness",
    appCategoryType: "public.app-category.developer-tools",
    executableName: "Pico",
    extraResource: [
      desktopAssetPath("icon.png"),
      "../../resources/sandbox",
      "../../resources/licenses",
    ],
    icon: desktopPackageIcon,
    name: "Pico",
    win32metadata: { CompanyName: "Pico", ProductName: "Pico", FileDescription: "Pico" },
    osxSign: macSigningIdentity ? { identity: macSigningIdentity } : undefined,
    osxNotarize: macNotarization,
  },
  makers: [
    new MakerZIP(updateBaseUrl ? { macUpdateManifestBaseUrl: `${updateBaseUrl}/darwin` } : {}, [
      "darwin",
    ]),
    new MakerHdiutilDmg(
      {
        name: "Pico",
      },
      ["darwin"],
    ),
    new MakerSquirrel(
      {
        authors: "Pico",
        description: "Pico Agent Harness desktop application",
        exe: "Pico.exe",
        // Squirrel owns and may replace this directory. Runtime data uses "pico".
        name: "pico_desktop",
        setupExe: "PicoSetup.exe",
        // Packager's icon only brands Pico.exe; Squirrel has separate defaults.
        setupIcon: desktopAssetPath("icon.ico"),
        iconUrl:
          "https://raw.githubusercontent.com/99Gaoxiaoqi/pico-harness/main/apps/desktop/assets/icon.ico",
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
        {
          entry: "src/main/daemon-entry.ts",
          config: "vite.daemon.config.ts",
          target: "main",
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
