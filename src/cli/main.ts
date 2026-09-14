#!/usr/bin/env node
import "@pico/cli/tui/preload-env";
import { runCliEntrypoint } from "@pico/cli/main";

export { runCli, type CliRuntime } from "@pico/cli/entry-dispatch";

await runCliEntrypoint({
  entrypointUrl: import.meta.url,
  packageUrl: new URL("../../package.json", import.meta.url),
});
