import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // 含真实磁盘 IO(bash/引擎/持久化落盘)的测试在并行环境下需要更宽松的超时。
    // 默认 5s 在全量并行时(benchmark/registry 跑引擎+bash)容易触发假超时。
    testTimeout: 15000,
  },
});
