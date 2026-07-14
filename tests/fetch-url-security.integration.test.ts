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
    const requestMock = vi.fn((url: URL, _addresses: readonly unknown[], signal: AbortSignal) =>
      fetch(url.href, { signal, redirect: "manual" }),
    );

    const registry = new ToolRegistry();
    registry.register(new FetchURLTool({ request: requestMock }));

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
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[1]).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
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

    for (const [id, url] of [
      ["fetch-mapped-loopback", "http://[::ffff:127.0.0.1]/"],
      ["fetch-nat64-loopback", "http://[64:ff9b::7f00:1]/"],
    ] as const) {
      const result = await registry.execute({
        id,
        name: "fetch_url",
        arguments: JSON.stringify({ url }),
      });
      expect(result).toMatchObject({
        isError: true,
        output: expect.stringContaining("非公网或保留地址"),
      });
    }
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("逐跳工具网络 allowlist 允许 A→B，并在 DNS 前阻断 A→C", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const requestedUrls: string[] = [];
    const requestMock = vi.fn(async (url: URL) => {
      requestedUrls.push(url.href);
      if (url.href === "https://a.example/allowed") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://b.example/final" },
        });
      }
      if (url.href === "https://a.example/blocked") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://c.example/secret" },
        });
      }
      return new Response("allowed", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    const allowedHosts = new Set(["a.example", "b.example"]);
    const registry = new ToolRegistry();
    registry.register(
      new FetchURLTool({
        request: requestMock,
        authorizeUrl: (url) => {
          if (!allowedHosts.has(url.hostname)) throw new Error(`工具网络拒绝 ${url.hostname}`);
        },
      }),
    );

    const allowed = await registry.execute({
      id: "allow-a-to-b",
      name: "fetch_url",
      arguments: JSON.stringify({ url: "https://a.example/allowed" }),
    });
    expect(allowed).toMatchObject({ isError: false });
    expect(requestedUrls).toEqual(["https://a.example/allowed", "https://b.example/final"]);

    const blocked = await registry.execute({
      id: "block-a-to-c",
      name: "fetch_url",
      arguments: JSON.stringify({ url: "https://a.example/blocked" }),
    });
    expect(blocked).toMatchObject({
      isError: true,
      output: expect.stringContaining("工具网络拒绝 c.example"),
    });
    expect(requestedUrls).toEqual([
      "https://a.example/allowed",
      "https://b.example/final",
      "https://a.example/blocked",
    ]);
    expect(vi.mocked(lookup)).not.toHaveBeenCalledWith("c.example", expect.anything());
  });
});
