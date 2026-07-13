// 网络工具:WebSearch(搜索)与 FetchURL(抓网页)。
// 阶段 2.4。
//
// 遵循 SkillViewTool 的跨文件工具模式:独立文件,消费者(default-registry.ts)直接 import。
// 两个工具均为 readOnly=true、accesses() 返回 ToolAccesses.none()
// (网络访问不算本地文件系统副作用,不参与资源冲突图调度)。
//
// 不引入新依赖:FetchURL 用 Node 内置 HTTP/TLS 固定已校验地址，WebSearch 用内置 fetch。

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { ToolDefinition } from "../schema/message.js";
import type { BaseTool } from "./registry.js";
import { ToolAccesses } from "./tool-access.js";

// FetchURL 抓取超时(网络请求兜底,防永久挂起)
const FETCH_URL_TIMEOUT_MS = 30_000;
// WebSearch 请求超时
const SEARCH_TIMEOUT_MS = 30_000;
// FetchURL 默认最大返回字符数(与 Registry 默认截断一致)
const DEFAULT_MAX_CHARS = 8000;
// 防止模型把 max_chars 当成无限下载开关；与通用大工具输出阈值保持一致。
const MAX_RETURN_CHARS = 50_000;
// 即便最终只返回少量字符，也最多从网络读取 2 MiB，避免超大响应耗尽内存。
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const BLOCKED_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_NETWORKS.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_NETWORKS.addSubnet(network, prefix, "ipv6");
}

const BLOCKED_METADATA_HOSTS = new Set([
  "instance-data.ec2.internal",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

export type FetchURLRequest = (
  url: URL,
  addresses: readonly LookupAddress[],
  signal: AbortSignal,
) => Promise<Response>;

/** 每个重定向目标在 DNS 解析与网络请求前都必须通过宿主授权。 */
export type FetchURLAuthorizer = (url: URL, redirectCount: number) => void | Promise<void>;

export interface FetchURLToolOptions {
  /** 仅供宿主替换传输层；默认实现会把连接固定到已经校验的 DNS 地址。 */
  request?: FetchURLRequest;
  /** 后台宿主注入的逐跳工具网络策略；不影响 Provider 网络。 */
  authorizeUrl?: FetchURLAuthorizer;
}

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
  if (url.username !== "" || url.password !== "") {
    throw new Error(`URL 不允许包含用户名或密码 (url=${raw})`);
  }
  return url;
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return BLOCKED_NETWORKS.check(address, "ipv4");
  if (family === 6) return BLOCKED_NETWORKS.check(address, "ipv6");
  return true;
}

/** 每次真正请求前解析并检查全部 A/AAAA 地址，避免任一候选落入宿主或保留网络。 */
async function resolvePublicTarget(url: URL): Promise<LookupAddress[]> {
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    BLOCKED_METADATA_HOSTS.has(hostname)
  ) {
    throw new Error(`拒绝抓取本地或元数据主机: '${hostname}'`);
  }

  const literalFamily = isIP(hostname);
  let addresses: LookupAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, order: "verbatim" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DNS 解析失败: '${hostname}': ${message}`, { cause: error });
    }
  }

  if (addresses.length === 0) {
    throw new Error(`DNS 解析未返回地址: '${hostname}'`);
  }
  if (addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
    throw new Error(`拒绝抓取: 主机 '${hostname}' 解析到非公网或保留地址`);
  }
  return addresses;
}

function requestedFamily(family: number | "IPv4" | "IPv6" | undefined): number {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

/** 将 HTTP/TLS 建连固定到本轮已经检查过的地址，消除检查后再次 DNS 解析的 rebinding 窗口。 */
function createPinnedLookup(addresses: readonly LookupAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = requestedFamily(options.family);
    const candidates =
      family === 0 ? [...addresses] : addresses.filter((item) => item.family === family);
    if (candidates.length === 0) {
      const error = Object.assign(new Error("没有符合请求地址族的已验证 DNS 地址"), {
        code: "ENOTFOUND",
      });
      callback(error, options.all ? [] : "", family || undefined);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0];
    if (!selected) {
      callback(Object.assign(new Error("没有已验证 DNS 地址"), { code: "ENOTFOUND" }), "");
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

const requestPinnedUrl: FetchURLRequest = async (url, addresses, signal) => {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: "GET",
        signal,
        lookup: createPinnedLookup(addresses),
        maxHeaderSize: 64 * 1024,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "identity",
          "User-Agent": "pico-harness/fetch_url",
        },
      },
      (incoming) => {
        const status = incoming.statusCode ?? 500;
        const hasBody = status !== 204 && status !== 205 && status !== 304;
        const body = hasBody ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>) : null;
        try {
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers: toWebHeaders(incoming.headers),
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
};

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithValidatedRedirects(
  initialUrl: URL,
  signal: AbortSignal,
  request: FetchURLRequest,
  authorizeUrl?: FetchURLAuthorizer,
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; ; redirectCount += 1) {
    // 授权必须发生在 DNS 之前；失败时该跳既不会解析，也不会发送请求。
    await authorizeUrl?.(currentUrl, redirectCount);
    const addresses = await resolvePublicTarget(currentUrl);
    const response = await request(currentUrl, addresses, signal);
    if (!isRedirectStatus(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, finalUrl: currentUrl };
    }
    if (redirectCount >= MAX_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`抓取失败: 重定向超过 ${MAX_REDIRECTS} 次 (url=${initialUrl.href})`);
    }

    let nextUrl: URL;
    try {
      nextUrl = assertHttpUrl(new URL(location, currentUrl).href);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = nextUrl;
  }
}

async function readResponseText(
  response: Response,
): Promise<{ text: string; bytesRead: number; byteLimitReached: boolean }> {
  if (!response.body) {
    return { text: "", bytesRead: 0, byteLimitReached: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let byteLimitReached = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - bytesRead;
      if (remaining === 0) {
        byteLimitReached = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      const accepted = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += accepted.byteLength;
      chunks.push(decoder.decode(accepted, { stream: true }));
      if (value.byteLength > remaining) {
        byteLimitReached = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(""), bytesRead, byteLimitReached };
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
  private readonly request: FetchURLRequest;
  private authorizeUrl?: FetchURLAuthorizer;

  constructor(options: FetchURLToolOptions = {}) {
    this.request = options.request ?? requestPinnedUrl;
    this.authorizeUrl = options.authorizeUrl;
  }

  /** AgentRuntime 在后台 Job 装配完成后注入，不改变前台默认行为。 */
  setAuthorizeUrl(authorizeUrl: FetchURLAuthorizer): void {
    this.authorizeUrl = authorizeUrl;
  }

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
            minimum: 1,
            maximum: MAX_RETURN_CHARS,
            description: `最大返回字符数,超出截断(默认 ${DEFAULT_MAX_CHARS},上限 ${MAX_RETURN_CHARS})`,
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
        maxChars = Math.min(MAX_RETURN_CHARS, Math.max(1, Math.floor(input.max_chars)));
      }
    } catch {
      throw new Error("参数解析失败: 期望 JSON 含 url 字段");
    }

    if (typeof url !== "string" || url.trim() === "") {
      throw new Error("fetch_url 缺少 url 参数");
    }

    // 2. URL 合法性校验(只允许 http/https)
    const parsed = assertHttpUrl(url);

    // 3. 每一跳都重新校验 DNS 与地址；禁用 fetch 自动重定向，防止跳入内网。
    const { response: resp, finalUrl } = await fetchWithValidatedRedirects(
      parsed,
      AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      this.request,
      this.authorizeUrl,
    );

    if (!resp.ok) {
      throw new Error(`抓取失败: HTTP ${resp.status} ${resp.statusText} (url=${finalUrl.href})`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const streamed = await readResponseText(resp);
    const raw = streamed.text;

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

    const byteLimitNotice = streamed.byteLimitReached
      ? `;响应超过 ${MAX_RESPONSE_BYTES} 字节,已停止读取`
      : "";
    return `[fetch_url] ${finalUrl.href} 读取 ${streamed.bytesRead} 字节,返回 ${body.length} 字符${byteLimitNotice}\n${truncated}`;
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
  const arr = Array.isArray(obj["results"])
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
