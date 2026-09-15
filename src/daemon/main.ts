#!/usr/bin/env node
import { runLocalDaemonEntrypoint } from "@pico/pico-host/daemon-main";
export { runLocalDaemon } from "@pico/pico-host/daemon-main";
await runLocalDaemonEntrypoint(import.meta.url);
