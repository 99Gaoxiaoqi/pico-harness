import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./bridge.js";

contextBridge.exposeInMainWorld("pico", createDesktopBridge(ipcRenderer));
