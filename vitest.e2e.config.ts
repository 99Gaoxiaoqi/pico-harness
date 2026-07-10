import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This command is the PR-safe E2E lane: no credentials and no external network.
    // Real-model tests have a separate fail-closed config (vitest.llm-e2e.config.ts).
    include: [
      "tests/e2e/file-history-e2e.test.ts",
      "tests/e2e/local-openai-e2e.test.ts",
      "tests/e2e/model-routing-e2e.test.ts",
    ],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
  },
});
