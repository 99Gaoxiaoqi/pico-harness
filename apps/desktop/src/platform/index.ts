import { platform } from "node:os";
import { DarwinPlatformServices } from "./darwin/index.js";
import type { PlatformServices } from "./services.js";
import { Win32PlatformServices } from "./win32/index.js";

export function createPlatformServices(
  targetPlatform: NodeJS.Platform = platform(),
): PlatformServices {
  if (targetPlatform === "darwin") return new DarwinPlatformServices();
  if (targetPlatform === "win32") return new Win32PlatformServices();
  throw new Error(`Pico Desktop 暂不支持 ${targetPlatform} 平台`);
}

export type { PlatformNotification, PlatformServices } from "./services.js";
