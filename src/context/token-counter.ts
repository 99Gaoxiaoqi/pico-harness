// 精确 Token 计数器(对标 hermes/gpt-tokenizer)。
//
// 痛点:全项目此前用 chars/4 估算 token,英文经验值对中文严重失真——
// 中文 1 字符常 ≈ 1~2 token,4 字符/token 会把中文对话的 token 数低估 2~4 倍,
// 导致 Compactor 的 retainLastTokens 保护区和 context-budget 的 token 预算切片
// 触发时机偏晚,可能在真溢出前没及时降级。
//
// 方案:用 gpt-tokenizer 的 BPE 词表(cl100k_base,GPT-4/Claude/GLM 的通用近似)
// 做真实分词计数。注意:这是**估算**(各厂商词表不完全相同),但比 chars/4 准很多。
// 项目只把它用于"压缩阈值判断"这类估算场景,真实计费始终走厂商返回的 usage。
//
// 工程细节:
//   - 懒加载:词表 ~数 MB,首次需要时才 import;也可进程启动时 await primeTokenizer() 抹平延迟。
//   - 同步可用:加载完成后 countTokens 是同步的(分词本身同步),保持调用方同步签名不变。
//     加载未完成时降级 chars/4 兜底,绝不阻塞主循环。
//   - LRU 缓存:同一段文本重复计数(常见:同一 system prompt 每轮估算)直接命中,
//     限制 512 条避免内存膨胀。
//   - 失败兜底:BPE 异常时降级 ceil(chars/4)(与旧行为一致),绝不抛错阻断主流程。

/** 降级用的旧经验值(BPE 失败/未加载时兜底,与改造前行为一致) */
const FALLBACK_CHARS_PER_TOKEN = 4;

/** 单条文本计数缓存上限(LRU 语义,超限丢最旧)。512 条覆盖典型 system prompt 复用场景。 */
const CACHE_MAX = 512;

type EncodeFn = (text: string) => number[];

let encoderState: EncodeFn | null | undefined = undefined; // undefined=未尝试, null=加载失败, fn=就绪
let loadingPromise: Promise<void> | null = null;

const cache = new Map<string, number>();

/**
 * 异步预加载 cl100k_base 词表。进程启动时调用可抹平首次估算的延迟。
 * 失败静默(降级路径会在后续 countTokens 中自动启用)。可重复调用,幂等。
 */
export async function primeTokenizer(): Promise<void> {
  if (encoderState !== undefined) return; // 已就绪或已失败
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const mod = await import("gpt-tokenizer");
      encoderState = mod.encode as EncodeFn;
    } catch {
      encoderState = null;
    } finally {
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/**
 * 同步计数一段文本的 token 数。
 * - 词表已就绪:BPE 分词计数(cl100k_base 近似)
 * - 词表未加载/失败:ceil(chars / 4) 兜底(与改造前���为一致)
 *
 * 不阻塞:词表加载是异步的,未就绪时走兜底;调用方可选在进程启动时
 * await primeTokenizer() 让首次估算即精确。命中缓存时 O(1)。
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;

  let count: number;
  if (encoderState) {
    try {
      count = encoderState(text).length;
    } catch {
      count = Math.max(1, Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN));
    }
  } else {
    count = Math.max(1, Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN));
  }

  // LRU 语义:超限删最旧(Map 保持插入序,首个即最旧)。
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, count);
  return count;
}

/** 清空计数缓存(主要用于测试隔离)。 */
export function resetTokenCounterCache(): void {
  cache.clear();
}
