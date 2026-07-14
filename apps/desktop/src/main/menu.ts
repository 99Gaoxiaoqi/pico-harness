import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export function installApplicationMenu(getWindow: () => BrowserWindow | undefined): void {
  const navigate = (hash: string) => navigateWindow(getWindow(), hash);
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "文件",
      submenu: [
        { label: "新建任务", accelerator: "CmdOrCtrl+N", click: () => navigate("/task/new") },
        {
          label: "任务工作库",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => navigate("/sessions"),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "前往",
      submenu: [
        { label: "任务", accelerator: "CmdOrCtrl+1", click: () => navigate("/") },
        { label: "审阅", accelerator: "CmdOrCtrl+2", click: () => navigate("/review") },
        { label: "自动化", accelerator: "CmdOrCtrl+3", click: () => navigate("/automations") },
        { label: "设置", accelerator: "CmdOrCtrl+,", click: () => navigate("/settings") },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function navigateWindow(window: BrowserWindow | undefined, hash: string): void {
  if (!window || window.isDestroyed()) return;
  const current = window.webContents.getURL();
  if (!current) return;
  const target = new URL(current);
  target.hash = `#${hash}`;
  void window.loadURL(target.toString());
  if (!window.isVisible()) window.show();
  window.focus();
}
