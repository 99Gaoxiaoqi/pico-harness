import type { DesktopBridge } from "./contract.js";

declare global {
  interface Window {
    readonly pico: DesktopBridge;
  }
}

export {};
