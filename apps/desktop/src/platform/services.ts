export interface PlatformNotification {
  readonly title: string;
  readonly body: string;
}

export interface PlatformServices {
  readonly platform: "darwin" | "win32";
  showNotification(notification: PlatformNotification): Promise<void>;
  openDirectory(path: string): Promise<void>;
  getLaunchAtLogin(): boolean;
  setLaunchAtLogin(enabled: boolean): void;
}
