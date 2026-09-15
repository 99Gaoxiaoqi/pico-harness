#!/usr/bin/env node
// Silence machine-readable execution before the host module constructs a logger.
process.env.LOG_LEVEL = "fatal";
const { runHeadlessOneShotEntrypoint } =
  await import("@pico/pico-host/internal/headless-one-shot-main");
void runHeadlessOneShotEntrypoint();
