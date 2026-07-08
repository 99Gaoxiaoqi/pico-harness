import { describe, expect, it, vi } from "vitest";

type SpawnSyncLike = (...args: unknown[]) => unknown;
type RunTuiSmoke = (options: {
  cwd: string;
  envExists: (path: string) => boolean;
  readEnvFile: (path: string) => string;
  spawnSync: SpawnSyncLike;
  log: (line: string) => void;
}) => number;

const smokeModule = (await import(new URL("../../scripts/tui-smoke.mjs", import.meta.url).href)) as {
  runTuiSmoke: RunTuiSmoke;
};
const { runTuiSmoke } = smokeModule;

describe("tui-smoke script", () => {
  it("缺少 .env 时输出 SKIP 并成功退出", () => {
    const spawnSync = vi.fn();
    const output: string[] = [];

    const result = runTuiSmoke({
      cwd: "/tmp/no-env",
      envExists: () => false,
      readEnvFile: () => "",
      spawnSync,
      log: (line) => output.push(line),
    });

    expect(result).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("SKIP");
    expect(output.join("\n")).toContain(".env");
  });

  it("缺少 provider 配置时输出 SKIP 并成功退出", () => {
    const spawnSync = vi.fn();
    const output: string[] = [];

    const result = runTuiSmoke({
      cwd: "/tmp/missing-provider",
      envExists: () => true,
      readEnvFile: () => "LLM_BASE_URL=https://example.test/v1\n",
      spawnSync,
      log: (line) => output.push(line),
    });

    expect(result).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain("SKIP");
    expect(output.join("\n")).toContain("LLM_API_KEY");
  });

  it("有配置时用参数数组依次执行四个真实 CLI prompt", () => {
    const output: string[] = [];
    const spawnSync = vi.fn((_bin, _args) => ({
      status: 0,
      stdout: "Pico status OK\nMore details\n",
      stderr: "",
    }));

    const result = runTuiSmoke({
      cwd: "/tmp/with-provider",
      envExists: () => true,
      readEnvFile: () => "LLM_BASE_URL=https://example.test/v1\nLLM_API_KEYS=a,b\n",
      spawnSync,
      log: (line) => output.push(line),
    });

    expect(result).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["run", "dev", "--", "--prompt", "/status"],
      expect.objectContaining({ cwd: "/tmp/with-provider", shell: false }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      4,
      "npm",
      ["run", "dev", "--", "--prompt", "/help"],
      expect.objectContaining({ cwd: "/tmp/with-provider", shell: false }),
    );
    expect(output.join("\n")).toContain("RUN /status");
    expect(output.join("\n")).toContain("EXIT /help 0");
    expect(output.join("\n")).toContain("Pico status OK");
  });

  it("任一 prompt 失败时继续输出摘要并返回失败码", () => {
    const output: string[] = [];
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "ok\n", stderr: "" })
      .mockReturnValueOnce({ status: 2, stdout: "", stderr: "mode failed\n" })
      .mockReturnValue({ status: 0, stdout: "ok\n", stderr: "" });

    const result = runTuiSmoke({
      cwd: "/tmp/with-provider",
      envExists: () => true,
      readEnvFile: () => "LLM_BASE_URL=https://example.test/v1\nLLM_API_KEY=key\n",
      spawnSync,
      log: (line) => output.push(line),
    });

    expect(result).toBe(1);
    expect(spawnSync).toHaveBeenCalledTimes(4);
    expect(output.join("\n")).toContain("EXIT /mode 2");
    expect(output.join("\n")).toContain("mode failed");
  });
});
