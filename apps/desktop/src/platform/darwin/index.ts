import { app, Notification, shell } from "electron";
import type { PlatformNotification, PlatformServices } from "../services.js";

export class DarwinPlatformServices implements PlatformServices {
  readonly platform = "darwin" as const;

  async showNotification(notification: PlatformNotification): Promise<void> {
    if (!Notification.isSupported()) throw new Error("当前 macOS 环境不支持系统通知");
    new Notification(notification).show();
  }

  async openDirectory(path: string): Promise<void> {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  }

  getLaunchAtLogin(): boolean {
    return app.getLoginItemSettings().openAtLogin;
  }

  setLaunchAtLogin(enabled: boolean): void {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
  }
}
