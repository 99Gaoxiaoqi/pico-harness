import { defineConfig } from "vitest/config";
import RealLlmExecutionReporter from "./tests/e2e/real-llm-reporter.js";

export default defineConfig({
  test: {
    // Current product acceptance lane: one OpenAI-compatible endpoint drives the
    // provider, ReAct loop, approval, skills/workspaces, hooks, and TUI orchestration.
    include: ["tests/e2e/**/*.test.ts"],
    exclude: [
      "tests/e2e/file-history-e2e.test.ts",
      "tests/e2e/local-openai-e2e.test.ts",
      // These require native Claude/vision endpoints and remain separately opt-in.
      "tests/e2e/stage1-claude-e2e.test.ts",
      "tests/e2e/stage5-vision-e2e.test.ts",
    ],
    environment: "node",
    setupFiles: ["tests/setup.ts", "tests/e2e/real-llm-env.setup.ts"],
    globalSetup: ["tests/e2e/real-llm.global-setup.ts"],
    reporters: ["default", new RealLlmExecutionReporter()],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
