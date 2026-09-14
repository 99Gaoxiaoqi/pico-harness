#!/usr/bin/env node
// Silence machine-readable execution before the host module constructs a logger.
process.env.LOG_LEVEL = "fatal";
const { runHeadlessBootstrapEntrypoint } = await import("@pico/pico-host/internal/headless-bootstrap-main");
void runHeadlessBootstrapEntrypoint();
