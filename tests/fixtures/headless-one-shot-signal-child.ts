import { setTimeout } from "node:timers/promises";

// This observer preload delays cold startup beyond the previous test's sleep;
// Node starts the original CLI entrypoint after the preload completes.
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
