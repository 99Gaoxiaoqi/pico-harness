// 网络工具:WebSearch(搜索)与 FetchURL(抓网页)。
// 阶段 2.4。
//
// 遵循 SkillViewTool 的跨文件工具模式:独立文件,消费者(default-registry.ts)直接 import。
// 两个工具均为 readOnly=true、accesses() 返回 ToolAccesses.none()
// (网络访问不算本地文件系统副作用,不参与资源冲突图调度)。
//
// 不引入新依赖:仅用 Node 18+ 内置 fetch,HTML 标签剥离用正则最简实现。

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";

// FetchURL 抓取超时(网络请求兜底,防永久挂起)
const FETCH_URL_TIMEOUT_MS = 30_000;
// WebSearch 请求超时
const SEARCH_TIMEOUT_MS = 30_000;
// FetchURL 默认最大返回字符数(与 Registry 默认截断一致)
const DEFAULT_MAX_CHARS = 8000;

/**
 * 校验字符串是否为合法 http(s) URL。
 * 用 new URL() 解析,只接受 http/https 协议(拒绝 file://、javascript: 等)。
 * 非法抛错,由调用方/Registry 封成 isError 反馈模型。
 */
function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`非法 URL: '${raw}'`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`仅支持 http/https 协议,收到: '${url.protocol}' (url=${raw})`);
  }
  return url;
}

/**
 * 把 HTML 粗清洗成纯文本(最简正则实现,不追求完美)。
 *
 * 步骤:
 * 1. 去 <script>...</script> 与 <style>...</style>(含内容,避免脚本/样式噪声)
 * 2. 去 <[^>]+> 所有标签
 * 3. 解码常见 HTML 实体:&nbsp; &amp; &lt; &gt; &quot; &apos; &#39;
 * 4. 压缩连续空白(多空格/制表符归一,行尾空白裁剪,连续空行合并为单个)
 */
export function stripHtml(html: string): string {
  let text = html;
  // 1. 去脚本与样式(含内容)。[\s\S] 跨行匹配。
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // 2. 去所有标签
  text = text.replace(/<[^>]+>/g, "");
  // 3. 解码常见实体
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
  // 4. 压缩空白:行尾空白裁剪,行内连续空白(空格/制表)归一为单空格,连续空行合并
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/**
 * 把抓取/搜索到的内容截断到 maxChars。
 * 超出则截断并追加 "... (已截断)"。
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... (已截断)`;
}

// ==========================================
// 内置工具:FetchURLTool
// 抓取指定 URL 的网页内容,返回纯文本(去 HTML 标签)。
// ==========================================

export class FetchURLTool implements BaseTool {
  readonly readOnly = true;

  name(): string {
    return "fetch_url";
  }

  /** 网络抓取无本地文件系统副作用,不参与资源冲突图调度 */
  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "fetch_url",
      description: "抓取指定 URL 的网页内容,返回纯文本(去除 HTML 标签)。",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓取的网页 URL,必须是 http(s) 链接" },
          max_chars: {
            type: "number",
            description: "最大返回字符数,超出截断(默认 8000)",
          },
        },
        required: ["url"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let url: string;
    let maxChars = DEFAULT_MAX_CHARS;
    try {
      const input = JSON.parse(args) as { url?: string; max_chars?: number };
      url = input.url ?? "";
      if (typeof input.max_chars === "number" && Number.isFinite(input.max_chars)) {
        maxChars = Math.max(0, Math.floor(input.max_chars));
      }
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 url 字段");
    }

    if (typeof url !== "string" || url.trim() === "") {
      throw new Error("fetch_url 缺少 url 参数");
    }

    // 2. URL 合法性校验(只允许 http/https)
    const parsed = assertHttpUrl(url);

    // 3. 发起请求(遵循 Provider 风格:AbortSignal.timeout 防永久挂起)
    const resp = await fetch(parsed.href, {
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!resp.ok) {
      throw new Error(`抓取失败: HTTP ${resp.status} ${resp.statusText} (url=${parsed.href})`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const raw = await resp.text();

    // 4. 按 content-type 选择处理:
    //    - text/html → strip 标签
    //    - application/json / text/* → 原样返回
    //    - 其他 → 也尝试 strip(保守,避免把二进制当文本)
    let body: string;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      body = stripHtml(raw);
    } else {
      body = raw;
    }

    // 5. 截断
    const truncated = truncate(body, maxChars);

    return `[fetch_url] ${parsed.href} 返回 ${body.length} 字符\n${truncated}`;
  }
}

// ==========================================
// 内置工具:WebSearchTool
// 网络搜索,返回结果列表(标题+URL+摘要)。
// 需配置 SEARCH_API_BASE / SEARCH_API_KEY 环境变量。
// ==========================================

/** 单条搜索结果(字段名容错:兼容 title/snippet 缺失) */
interface SearchResult {
  title?: string;
  url?: string;
  link?: string;
  snippet?: string;
  description?: string;
}

/**
 * 防御性解析搜索 API 返回的 JSON。
 * 容错字段名:url/link、snippet/description;非数组/缺字段返回空数组。
 */
function parseSearchResults(data: unknown): SearchResult[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  // 优先 results,其次 items/data(常见搜索 API 命名)
  const arr =
    Array.isArray(obj["results"])
      ? (obj["results"] as unknown[])
      : Array.isArray(obj["items"])
        ? (obj["items"] as unknown[])
        : Array.isArray(obj["data"])
          ? (obj["data"] as unknown[])
          : [];
  return arr
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      title: typeof item["title"] === "string" ? (item["title"] as string) : undefined,
      url: typeof item["url"] === "string" ? (item["url"] as string) : undefined,
      link: typeof item["link"] === "string" ? (item["link"] as string) : undefined,
      snippet:
        typeof item["snippet"] === "string"
          ? (item["snippet"] as string)
          : typeof item["description"] === "string"
            ? (item["description"] as string)
            : undefined,
    }));
}

/** 把搜索结果渲染成 Markdown 列表 */
function renderResults(results: SearchResult[], max: number): string {
  const shown = results.slice(0, max);
  if (shown.length === 0) {
    return "搜索返回了 0 条结果。";
  }
  const lines: string[] = [];
  shown.forEach((r, i) => {
    const title = r.title ?? "(无标题)";
    const link = r.url ?? r.link ?? "";
    const snippet = r.snippet ?? "";
    lines.push(`${i + 1}. **${title}**`);
    if (link) lines.push(`   ${link}`);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return lines.join("\n");
}

export class WebSearchTool implements BaseTool {
  readonly readOnly = true;

  name(): string {
    return "web_search";
  }

  /** 网络搜索无本地文件系统副作用,不参与资源冲突图调度 */
  accesses(_args?: string): ToolAccesses {
    return ToolAccesses.none();
  }

  definition(): ToolDefinition {
    return {
      name: "web_search",
      description:
        "网络搜索,返回结果列表(标题+URL+摘要)。需配置搜索 API(SEARCH_API_BASE/SEARCH_API_KEY 环境变量)。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          max_results: { type: "number", description: "最大返回结果数(默认 5)" },
        },
        required: ["query"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    // 1. 延迟解析 JSON 参数
    let query: string;
    let maxResults = 5;
    try {
      const input = JSON.parse(args) as { query?: string; max_results?: number };
      query = input.query ?? "";
      if (typeof input.max_results === "number" && Number.isFinite(input.max_results)) {
        maxResults = Math.max(1, Math.floor(input.max_results));
      }
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 query 字段");
    }

    if (typeof query !== "string" || query.trim() === "") {
      throw new Error("web_search 缺少 query 参数");
    }

    // 2. 读环境变量;未配置时返回明确提示(不抛错,让模型知道可改用 fetch_url)
    const apiBase = process.env["SEARCH_API_BASE"];
    const apiKey = process.env["SEARCH_API_KEY"];

    if (!apiBase || !apiKey) {
      return (
        "未配置搜索 API,请设置 SEARCH_API_BASE 和 SEARCH_API_KEY 环境变量," +
        "或改用 fetch_url 直接抓取已知 URL。"
      );
    }

    // 3. 发起搜索请求(网络错误 try/catch,返回提示而非抛错)
    const searchUrl = `${apiBase}?q=${encodeURIComponent(query)}&num=${maxResults}`;
    try {
      const resp = await fetch(searchUrl, {
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!resp.ok) {
        const statusText = `${resp.status} ${resp.statusText}`.trim();
        return `搜索请求失败: HTTP ${statusText}。请检查 SEARCH_API_BASE / SEARCH_API_KEY 配置。`;
      }

      const data: unknown = await resp.json();
      const results = parseSearchResults(data);
      const rendered = renderResults(results, maxResults);

      return `[web_search] "${query}" 返回 ${results.length} 条结果\n${rendered}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `搜索失败: ${msg}。可改用 fetch_url 直接抓取已知 URL。`;
    }
  }
}
