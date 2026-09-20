import { app } from "electron";
import { handleSquirrelStartup } from "./squirrel-startup.js";

// Installer callbacks must not initialize storage, a daemon, or the normal UI.
if (!handleSquirrelStartup()) {
  void import("./application.js").catch((error: unknown) => {
    console.error("Pico desktop bootstrap failed", error);
    app.exit(1);
  });
}
