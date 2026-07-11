// FetchURLTool 与 WebSearchTool 的单元测试。
// 全程 mock fetch,不真实联网。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchURLTool, WebSearchTool, stripHtml } from "../../src/tools/web.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

/** 构造一个最小的 Response-like mock(只暴露 fetch_url 用到的字段) */
function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  text: string;
}) {
  const headers = new Map<string, string>();
  if (opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(opts.text));
      controller.close();
    },
  });
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "",
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
    body,
    text: async () => opts.text,
    // web_search 走 resp.json();fetch_url 走 resp.text()
    json: async () => JSON.parse(opts.text),
  };
}

describe("FetchURLTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("抓取 HTML 并 strip 标签(去 script/style + 解码实体)", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        contentType: "text/html; charset=utf-8",
        text: "<html><body><script>x</script><p>Hello &amp; world</p></body></html>",
      }) as unknown as Response,
    );

    const tool = new FetchURLTool();
    const out = await tool.execute(JSON.stringify({ url: "https://example.com" }));

    expect(out).toContain("Hello & world");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<p>");
    expect(out).toContain("[fetch_url]");
  });

  it("非 HTML(text/plain、application/json)原样返回", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        contentType: "application/json",
        text: '{"ok":true}',
      }) as unknown as Response,
    );

    const tool = new FetchURLTool();
    const out = await tool.execute(JSON.stringify({ url: "https://api.example.com" }));
    expect(out).toContain('{"ok":true}');
  });

  it("非 200 状态码抛错带状态码", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: "nope",
      }) as unknown as Response,
    );

    const tool = new FetchURLTool();
    await expect(
      tool.execute(JSON.stringify({ url: "https://example.com/missing" })),
    ).rejects.toThrow(/404/);
  });

  it("非法 URL 抛错", async () => {
    const tool = new FetchURLTool();
    await expect(tool.execute(JSON.stringify({ url: "not-a-url" }))).rejects.toThrow(/非法 URL/);
  });

  it("拒绝非 http/https 协议(file://)", async () => {
    const tool = new FetchURLTool();
    await expect(tool.execute(JSON.stringify({ url: "file:///etc/passwd" }))).rejects.toThrow(
      /http\/https/,
    );
  });

  it("max_chars 截断:超长内容被截断并标注", async () => {
    const long = "<p>" + "A".repeat(200) + "</p>";
    fetchSpy.mockResolvedValue(
      mockResponse({ contentType: "text/html", text: long }) as unknown as Response,
    );

    const tool = new FetchURLTool();
    const out = await tool.execute(JSON.stringify({ url: "https://example.com", max_chars: 50 }));
    expect(out).toContain("已截断");
    // 截断后的正文部分应不超过 50 字符 + 标注
    expect(out.length).toBeLessThan(long.length);
  });

  it("参数格式错误时抛出解析错误", async () => {
    const tool = new FetchURLTool();
    await expect(tool.execute("not-json")).rejects.toThrow(/参数解析失败/);
  });

  it("经 Registry execute 路由分发", async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        contentType: "text/html",
        text: "<p>via registry</p>",
      }) as unknown as Response,
    );

    const r = new ToolRegistry();
    r.register(new FetchURLTool());
    const result = await r.execute({
      id: "c1",
      name: "fetch_url",
      arguments: JSON.stringify({ url: "https://example.com" }),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("via registry");
  });

  it("readOnly=true 且 accesses 返回 none(可与其他工具并行)", () => {
    const tool = new FetchURLTool();
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
  });
});

describe("WebSearchTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    // 恢复环境变量
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
  });

  it("未配置环境变量时返回配置提示(不抛错)", async () => {
    delete process.env["SEARCH_API_BASE"];
    delete process.env["SEARCH_API_KEY"];

    const tool = new WebSearchTool();
    const out = await tool.execute(JSON.stringify({ query: "anything" }));

    expect(out).toContain("未配置搜索 API");
    expect(out).toContain("SEARCH_API_BASE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("已配置时 mock fetch 返回结果并渲染成 Markdown 列表", async () => {
    process.env["SEARCH_API_BASE"] = "https://search.example.com/api";
    process.env["SEARCH_API_KEY"] = "secret-key";

    fetchSpy.mockResolvedValue(
      mockResponse({
        contentType: "application/json",
        text: JSON.stringify({ results: [{ title: "T", url: "http://x", snippet: "S" }] }),
      }) as unknown as Response,
    );

    const tool = new WebSearchTool();
    const out = await tool.execute(JSON.stringify({ query: "pico harness" }));

    // 验证渲染成列表:含序号、加粗标题、URL、摘要
    expect(out).toContain("**T**");
    expect(out).toContain("http://x");
    expect(out).toContain("S");
    expect(out).toMatch(/^1\.\s/m);

    // 验证请求带了 Authorization header
    const callArgs = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callArgs?.headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  it("fetch 失败时返回错误提示不抛", async () => {
    process.env["SEARCH_API_BASE"] = "https://search.example.com/api";
    process.env["SEARCH_API_KEY"] = "secret-key";

    fetchSpy.mockRejectedValue(new Error("网络中断"));

    const tool = new WebSearchTool();
    const out = await tool.execute(JSON.stringify({ query: "anything" }));

    expect(typeof out).toBe("string");
    expect(out).toContain("搜索失败");
    expect(out).toContain("网络中断");
  });

  it("非 200 时返回失败提示不抛", async () => {
    process.env["SEARCH_API_BASE"] = "https://search.example.com/api";
    process.env["SEARCH_API_KEY"] = "secret-key";

    fetchSpy.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: "",
      }) as unknown as Response,
    );

    const tool = new WebSearchTool();
    const out = await tool.execute(JSON.stringify({ query: "anything" }));
    expect(out).toContain("401");
    expect(out).toContain("搜索请求失败");
  });

  it("参数格式错误时抛出解析错误", async () => {
    const tool = new WebSearchTool();
    await expect(tool.execute("not-json")).rejects.toThrow(/参数解析失败/);
  });

  it("经 Registry execute 路由分发(未配置 → 返回提示,非 isError)", async () => {
    delete process.env["SEARCH_API_BASE"];
    delete process.env["SEARCH_API_KEY"];

    const r = new ToolRegistry();
    r.register(new WebSearchTool());
    const result = await r.execute({
      id: "c1",
      name: "web_search",
      arguments: JSON.stringify({ query: "x" }),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("未配置搜索 API");
  });

  it("经 Registry execute 路由分发(已配置 → 返回列表)", async () => {
    process.env["SEARCH_API_BASE"] = "https://search.example.com/api";
    process.env["SEARCH_API_KEY"] = "secret-key";

    fetchSpy.mockResolvedValue(
      mockResponse({
        contentType: "application/json",
        text: JSON.stringify({ results: [{ title: "A", url: "http://a", snippet: "B" }] }),
      }) as unknown as Response,
    );

    const r = new ToolRegistry();
    r.register(new WebSearchTool());
    const result = await r.execute({
      id: "c1",
      name: "web_search",
      arguments: JSON.stringify({ query: "x" }),
    });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("**A**");
  });

  it("readOnly=true 且 accesses 返回 none", () => {
    const tool = new WebSearchTool();
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
  });
});

describe("stripHtml 单元测试", () => {
  it("去 script 与 style 内容", () => {
    const out = stripHtml("<style>.a{color:red}</style><script>alert(1)</script>text");
    expect(out).toBe("text");
  });

  it("解码常见实体", () => {
    const out = stripHtml("&nbsp;a&amp;b&lt;c&gt;d&quot;e&#39;f&apos;g");
    expect(out).toBe("a&b<c>d\"e'f'g");
  });

  it("压缩连续空白(行内多空格归一,连续空行合并至单个)", () => {
    const out = stripHtml("<p>a    b\n\n\n  c</p>");
    // 行内多空格 → 单空格;每行去首尾空白;c 行缩进被裁掉;连续空行合并保留一个
    expect(out).toBe("a b\n\nc");
  });
});
