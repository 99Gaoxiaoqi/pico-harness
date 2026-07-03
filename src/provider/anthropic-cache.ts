// Anthropic Prompt Cache 断点注入器。
//
// 背景:Anthropic API 支持在请求体的 content block / system / tools 上标记
// `cache_control: { type: "ephemeral" }`,服务端据此缓存前缀(默认 5 分钟,
// 滚动续期)。命中后 cache_read 输入单价降至约 1/10,实测长会话输入成本可降 ~75%。
//
// 限制(Anthropic 官方约束):
//   - 单次请求最多 4 个 ephemeral 断点,超出会 400。
//   - 断点位置必须是某个 block,缓存范围是"从开头到该 block(含)"。
//
// 注入策略(按"稳定性从高到低"占用断点,稳定前缀越大缓存命中率越高):
//   断点① system —— 身份/规范/AGENTS.md,同一 Session 内基本不变,缓存收益最大。
//   断点② tools 尾 —— 工具 Schema 在运行期固定,缓存后所有轮次复用。
//   断点③ 历史前缀尾 —— 把"已发生的对话"划为稳定区,只让最新一轮进入非缓存区。
//   第④个断点保留余量(如未来给 skills/memory 块用),暂不占满,降低越界风险。
//
// 关键:断点③需要在 messages 翻译完成后定位"倒数第二条消息"——
// 因为最后一条通常是本轮 user 输入(每轮都变),不应进缓存边界。
//
// 设计参考:hermes providers/base.py 的 apply_anthropic_cache_control。

/** Anthropic cache_control 标记。当前仅支持 ephemeral(短时滚动缓存)。 */
export interface CacheControl {
  type: "ephemeral";
  /** 可选 TTL 秒(Anthropic 支持 300/3600,省略走默认 300)。预留扩展,当前不发。 */
  ttl?: "5m" | "1h";
}

/** 可被注入 cache_control 的 block 形状(放宽,适配 system/tools/messages 三种)。 */
interface CacheableBlock {
  cache_control?: CacheControl;
  [key: string]: unknown;
}

/**
 * 给单个 block 注入 cache_control(原地修改,返回同引用便于链式)。
 * 已存在 cache_control 时不覆盖(调用方保证一个 block 只打一处断点)。
 */
export function markCacheBreakpoint(block: CacheableBlock): CacheableBlock {
  if (block.cache_control === undefined) {
    block.cache_control = { type: "ephemeral" };
  }
  return block;
}

/**
 * Anthropic 单请求允许的 cache_control 断点上限(官方约束)。
 * 超出会返回 400 invalid_request_error: too many cache breakpoints。
 */
export const MAX_CACHE_BREAKPOINTS = 4;

/**
 * 本实现默认占用的断点数(system + tools 尾 + 历史前缀尾 = 3)。
 * 预留 1 个余量,降低未来扩展(skills/memory 块)时的越界风险。
 */
export const DEFAULT_USED_BREAKPOINTS = 3;

/**
 * 在已翻译好的 Anthropic 请求体上注入 cache_control 断点。
 *
 * 输入是"即将 JSON.stringify 发出去的请求体对象",本函数原地修改它。
 * 任一组件缺失(如无 tools / 无 system)则跳过该断点,不报错。
 *
 * @param body 请求体(会被原地修改):
 *   - system: string | Block[] —— 字符串时转成单元素 Block 数组再打断点
 *   - tools: Tool[] —— 给最后一个 tool 打断点
 *   - messages: {role, content: Block[]}[] —— 给历史前缀尾打断点
 * @param enabled 是否启用(为 false 时原样返回,不动 body)。默认 true。
 * @returns 实际注入的断点数(供测试与 Tracing 断言)
 */
export function applyAnthropicCacheControl(
  body: {
    system?: string | CacheableBlock[];
    tools?: CacheableBlock[];
    messages?: { role: string; content: CacheableBlock[] | string }[];
  },
  enabled = true,
): number {
  if (!enabled) return 0;
  let used = 0;

  // 断点① system:字符串 → Block 数组,在(唯一的)text block 上打断点。
  // 已是数组时,在末元素打断点(system 多块场景兼容)。
  if (body.system !== undefined && used < MAX_CACHE_BREAKPOINTS) {
    if (typeof body.system === "string") {
      body.system = [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }];
      used++;
    } else if (body.system.length > 0) {
      const last = body.system[body.system.length - 1]!;
      if (last.cache_control === undefined) {
        last.cache_control = { type: "ephemeral" };
        used++;
      }
    }
  }

  // 断点② tools 尾:工具集在运行期固定,缓存后所有轮次复用 schema。
  if (body.tools && body.tools.length > 0 && used < MAX_CACHE_BREAKPOINTS) {
    const lastTool = body.tools[body.tools.length - 1]!;
    if (lastTool.cache_control === undefined) {
      lastTool.cache_control = { type: "ephemeral" };
      used++;
    }
  }

  // 断点③ 历史前缀尾:把"倒数第二条消息的最后一个 block"打上断点,
  // 划出"稳定历史区 | 最新一轮"边界。倒数第一条通常是本轮 user 输入(每轮变)。
  if (body.messages && body.messages.length >= 2 && used < MAX_CACHE_BREAKPOINTS) {
    const prefixTail = body.messages[body.messages.length - 2]!;
    const content = prefixTail.content;
    // content 是 string 时(如纯 user 文本)无法打断点(Anthropic 要求 block 形式);
    // 仅当 content 为 Block 数组时在末 block 注入。
    if (Array.isArray(content) && content.length > 0) {
      const lastBlock = content[content.length - 1]!;
      if (lastBlock.cache_control === undefined) {
        lastBlock.cache_control = { type: "ephemeral" };
        used++;
      }
    }
  }

  return used;
}
