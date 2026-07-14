import { app, type BrowserWindow } from "electron";

export class DesktopLifecycleController {
  private backgroundMode = false;
  private quitting = false;

  constructor(private readonly getWindow: () => BrowserWindow | undefined) {}

  setBackgroundMode(enabled: boolean): void {
    this.backgroundMode = enabled;
  }

  shouldKeepInBackground(): boolean {
    return this.backgroundMode && !this.quitting;
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
