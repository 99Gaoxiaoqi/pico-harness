import { contextBridge, ipcRenderer } from "electron";
import { createCommandBridge } from "../../apps/desktop/src/preload/command-bridge.js";
contextBridge.exposeInMainWorld("testCommandBridge", createCommandBridge(ipcRenderer));
contextBridge.exposeInMainWorld("testNativeSlash", () => ipcRenderer.invoke("test:native-slash"));
