import { app } from "electron";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { resolveSquirrelUpdaterPath } from "./squirrel-paths.js";

export function handleSquirrelStartup(): boolean {
  if (process.platform !== "win32") return false;
  const event = process.argv[1];
  if (event === "--squirrel-obsolete") {
    app.quit();
    return true;
  }
  if (
    event !== "--squirrel-install" &&
    event !== "--squirrel-updated" &&
    event !== "--squirrel-uninstall"
  )
    return false;

  const updater = resolveSquirrelUpdaterPath(process.execPath);
  const command = event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";
  const child = spawn(updater, [command, basename(process.execPath)], { windowsHide: true });
  const timeout = setTimeout(() => {
    child.kill();
    console.error("Pico installer shortcut operation timed out");
    app.exit(1);
  }, 10_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    console.error("Pico installer shortcut operation failed", error);
    app.exit(1);
  });
  child.once("close", (code) => {
    clearTimeout(timeout);
    app.exit(code === 0 ? 0 : 1);
  });
  return true;
}
