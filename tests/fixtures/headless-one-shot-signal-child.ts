import { setTimeout } from "node:timers/promises";

// Exercise cold startup beyond the previous test's 1.5-second sleep without
// changing the production entrypoint or its signal handlers.
if (process.env["HEADLESS_SIGNAL_SLOW_BOOTSTRAP"] === "1") await setTimeout(2_200);

let readySent = false;
const onNewListener = (event: string | symbol) => {
  if (event !== "SIGINT" && event !== "SIGTERM") return;
  queueMicrotask(() => {
    // newListener fires before installation; check after both real handlers exist.
    if (
      readySent ||
      process.listenerCount("SIGINT") === 0 ||
      process.listenerCount("SIGTERM") === 0
    )
      return;
    readySent = true;
    process.removeListener("newListener", onNewListener);
    process.send?.({ kind: "signal-handlers-ready", stdinOpen: !process.stdin.readableEnded });
  });
};
process.on("newListener", onNewListener);
await import("../../src/internal/headless-one-shot-main.js");
