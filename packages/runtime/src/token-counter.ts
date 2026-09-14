/** 降级用的旧经验值（BPE 失败/未加载时兜底，与既有行为一致）。 */
const FALLBACK_CHARS_PER_TOKEN = 4;

/** 单条文本计数缓存上限；Map 插入序实现 LRU。 */
const CACHE_MAX = 512;

type EncodeFn = (text: string) => number[];

// undefined=未尝试，null=加载失败，fn=就绪。
let encoderState: EncodeFn | null | undefined;
let loadingPromise: Promise<void> | null = null;

const cache = new Map<string, number>();

/**
 * 异步预加载 cl100k_base 词表。失败静默，后续 countTokens 自动走兼容降级路径。
 */
export async function primeTokenizer(): Promise<void> {
  if (encoderState !== undefined) return;
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
 * 同步估算一段文本的 token 数。词表未就绪或异常时保持 ceil(chars / 4) 的旧降级语义，
 * 不会阻塞 Agent 主循环。
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

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, count);
  return count;
}
