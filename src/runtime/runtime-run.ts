import { configureRuntimeRunDiagnostics } from "@pico/runtime/runtime-run-diagnostics";
import { logger } from "../observability/logger.js";

configureRuntimeRunDiagnostics(logger);

export * from "@pico/runtime/runtime-run";
