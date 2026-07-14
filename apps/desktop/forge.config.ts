import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { chmod, cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const macSigningIdentity = process.env.PICO_MAC_SIGN_IDENTITY;
const appleId = process.env.PICO_APPLE_ID;
const appleIdPassword = process.env.PICO_APPLE_ID_PASSWORD;
const appleTeamId = process.env.PICO_APPLE_TEAM_ID;
const updateBaseUrl = process.env.PICO_UPDATE_BASE_URL?.replace(/\/$/u, "");
const workspaceRoot = resolve(import.meta.dirname, "../..");
const nativeRuntimePackages = [
  "better-sqlite3",
  "bindings",
  "file-uri-to-path",
  "node-pty",
  "node-addon-api",
] as const;

const macNotarization =
  appleId && appleIdPassword && appleTeamId
    ? { appleId, appleIdPassword, teamId: appleTeamId }
    : undefined;

const config = {
  packagerConfig: {
    appBundleId: "com.pico.harness",
    appCategoryType: "public.app-category.developer-tools",
    asar: {
      unpack: "**/*.node",
      unpackDir: "**/node_modules/node-pty",
    },
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
    packageAfterPrune: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
      const nodePtyRoot = join(buildPath, "node_modules", "node-pty");
      await Promise.all([
        rm(join(nodePtyRoot, "build"), { recursive: true, force: true }),
        rm(join(nodePtyRoot, "bin"), { recursive: true, force: true }),
      ]);
      const targetPrebuild = `${platform}-${arch}`;
      const prebuildsRoot = join(nodePtyRoot, "prebuilds");
      for (const entry of await readdir(prebuildsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== targetPrebuild) {
          await rm(join(prebuildsRoot, entry.name), { recursive: true, force: true });
        }
      }
      if (platform !== "win32") {
        await chmod(join(prebuildsRoot, targetPrebuild, "spawn-helper"), 0o755);
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
