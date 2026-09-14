import { configureHookExecutorLogger } from "@pico/pico-host/hooks/executors";
import { logger } from "../../observability/logger.js";

configureHookExecutorLogger(logger);

export * from "@pico/pico-host/hooks/executors";
