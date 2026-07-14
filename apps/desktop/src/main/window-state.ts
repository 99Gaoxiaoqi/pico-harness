import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { screen, type Rectangle } from "electron";

const DEFAULT_BOUNDS = { width: 1280, height: 820 } as const;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 640;

interface StoredWindowState {
  readonly version: 1;
  readonly bounds: Rectangle;
  readonly maximized: boolean;
}

export class WindowStateStore {
  private readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, "window-state.json");
  }

  async read(): Promise<StoredWindowState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (isStoredWindowState(parsed) && isVisibleOnAnyDisplay(parsed.bounds)) return parsed;
    } catch {
      // Missing and malformed state both fall back to a safe centered window.
    }
    return {
      version: 1,
      bounds: { x: 0, y: 0, ...DEFAULT_BOUNDS },
      maximized: false,
    };
  }

  async write(state: StoredWindowState): Promise<void> {
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

export function createWindowState(bounds: Rectangle, maximized: boolean): StoredWindowState {
  return { version: 1, bounds, maximized };
}

function isStoredWindowState(value: unknown): value is StoredWindowState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredWindowState>;
  return (
    candidate.version === 1 &&
    typeof candidate.maximized === "boolean" &&
    isValidBounds(candidate.bounds)
  );
}

function isValidBounds(value: unknown): value is Rectangle {
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as Partial<Rectangle>;
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    (bounds.width ?? 0) >= MIN_WIDTH &&
    (bounds.height ?? 0) >= MIN_HEIGHT
  );
}

function isVisibleOnAnyDisplay(bounds: Rectangle): boolean {
  return screen
    .getAllDisplays()
    .some(({ workArea }) => intersectionArea(bounds, workArea) >= 10_000);
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  return width * height;
}
