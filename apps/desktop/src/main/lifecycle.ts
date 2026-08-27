import { app, type BrowserWindow } from "electron";
import { createDesktopPreferences, type DesktopPreferencesStore } from "./preferences.js";

export class DesktopLifecycleController {
  private backgroundMode = false;
  private quitting = false;

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly preferences?: DesktopPreferencesStore,
  ) {}

  async initialize(): Promise<void> {
    if (this.preferences) this.backgroundMode = (await this.preferences.read()).backgroundMode;
  }

  getBackgroundMode(): boolean {
    return this.backgroundMode;
  }

  async setBackgroundMode(enabled: boolean): Promise<void> {
    if (this.preferences) await this.preferences.write(createDesktopPreferences(enabled));
    this.backgroundMode = enabled;
  }

  shouldKeepInBackground(): boolean {
    return this.backgroundMode && !this.quitting;
  }

  isQuitting(): boolean {
    return this.quitting;
  }

  requestQuit(): void {
    this.quitting = true;
    setTimeout(() => app.quit(), 0);
  }

  markQuitting(): void {
    this.quitting = true;
  }

  showWindow(): void {
    const window = this.getWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
