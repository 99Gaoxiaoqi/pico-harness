import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DesktopPreferences {
  readonly version: 1;
  readonly backgroundMode: boolean;
}

const DEFAULT_PREFERENCES: DesktopPreferences = {
  version: 1,
  backgroundMode: false,
};

export class DesktopPreferencesStore {
  private readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, "preferences.json");
  }

  async read(): Promise<DesktopPreferences> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (isDesktopPreferences(parsed)) return parsed;
    } catch {
      // Missing and malformed preferences both use the safe foreground-only default.
    }
    return DEFAULT_PREFERENCES;
  }

  async write(preferences: DesktopPreferences): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(preferences)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}

export function createDesktopPreferences(backgroundMode: boolean): DesktopPreferences {
  return { version: 1, backgroundMode };
}

function isDesktopPreferences(value: unknown): value is DesktopPreferences {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DesktopPreferences>;
  return candidate.version === 1 && typeof candidate.backgroundMode === "boolean";
}
