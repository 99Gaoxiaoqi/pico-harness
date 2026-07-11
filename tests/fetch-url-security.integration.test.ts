import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchURLTool } from "../src/tools/web.js";
import { ToolRegistry } from "../src/tools/registry-impl.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.mocked(lookup).mockReset();
});

describe("fetch_url 安全边界集成", () => {
  it("Registry 主链逐跳校验全部 DNS 地址、限制响应大小并拒绝私网", async () => {
    vi.mocked(lookup).mockImplementation(async (hostname) => {
      if (hostname === "mixed.example") {
        return [
          { address: "8.8.8.8", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ];
      }
      return [
        { address: "8.8.8.8", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ];
    });

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("A".repeat(2 * 1024 * 1024 + 1024)));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://final.example/content" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(oversizedBody, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://mixed.example/secret" },
        }),
      );
    globalThis.fetch = fetchMock;

    const registry = new ToolRegistry();
    registry.register(new FetchURLTool());

    const success = await registry.execute({
      id: "fetch-safe",
      name: "fetch_url",
      arguments: JSON.stringify({
        url: "https://start.example/path",
        max_chars: 999_999,
      }),
    });
    expect(success.isError).toBe(false);
    expect(success.output).toContain("https://final.example/content");
    expect(success.output).toContain("响应超过 2097152 字节,已停止读取");
    expect(success.output).toContain("已截断");
    expect(success.output.length).toBeLessThan(51_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "manual")).toBe(true);
    expect(vi.mocked(lookup)).toHaveBeenCalledWith("start.example", {
      all: true,
      order: "verbatim",
    });
    expect(vi.mocked(lookup)).toHaveBeenCalledWith("final.example", {
      all: true,
      order: "verbatim",
    });

    const blocked = await registry.execute({
      id: "fetch-blocked",
      name: "fetch_url",
      arguments: JSON.stringify({ url: "https://redirect-block.example/start" }),
    });
    expect(blocked).toMatchObject({
      isError: true,
      output: expect.stringContaining("非公网或保留地址"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
