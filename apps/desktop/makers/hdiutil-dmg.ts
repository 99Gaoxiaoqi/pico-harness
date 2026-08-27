import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";

interface HdiutilDmgConfig {
  name?: string;
  volumeName?: string;
}

const execFileAsync = promisify(execFile);

export class MakerHdiutilDmg extends MakerBase<HdiutilDmgConfig> {
  name = "dmg";

  defaultPlatforms: ForgePlatform[] = ["darwin"];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === "darwin";
  }

  override async make({
    dir,
    makeDir,
    appName,
    packageJSON,
    targetArch,
  }: MakerOptions): Promise<string[]> {
    const sourceApplication = resolve(dir, `${appName}.app`);
    await access(sourceApplication);

    const dmgDirectory = resolve(makeDir, "dmg", targetArch);
    const dmgName = this.config.name ?? `${appName}-${packageJSON.version}-${targetArch}`;
    const dmgPath = resolve(dmgDirectory, `${dmgName}.dmg`);
    await this.ensureFile(dmgPath);

    await execFileAsync(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        this.config.volumeName ?? appName,
        "-srcfolder",
        dir,
        "-format",
        "UDZO",
        "-ov",
        dmgPath,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    await access(dmgPath);
    return [dmgPath];
  }
}
