import { configureRuntimeRunDiagnostics } from "@pico/runtime/runtime-run-diagnostics";
import { logger } from "@pico/pico-host/logger";

configureRuntimeRunDiagnostics(logger);

export * from "@pico/runtime/runtime-run";
