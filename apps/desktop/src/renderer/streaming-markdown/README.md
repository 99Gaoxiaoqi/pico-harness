# Streaming Markdown

流式 Markdown 增量渲染模块。对标 [LiYanan2004/MarkdownView](https://github.com/LiYanan2004/MarkdownView) 的流式体验：文本先进入独立数据源，视图按块渲染，已完成块解析结果缓存复用，只重解析尾部未完成块，`finish()` 后做一次全量解析保证结构正确。

模块位于 `apps/desktop/src/renderer/streaming-markdown/`，当前**不接线**到对话页；接线由后续 PR 完成。

## 快速使用

```tsx
import { StreamingMarkdownSource, StreamingMarkdownView } from "./streaming-markdown";

const source = new StreamingMarkdownSource();

// token 回调里高频调用即可，同一微任务内的多次 append 会合并成一次提交
source.append("第一段");
source.append("继续输出……");

source.finish(); // 流结束：提交剩余文本并触发最终全量解析

<StreamingMarkdownView source={source} throttleMs={50} />;
```

### `<StreamingMarkdownView />` Props

| Prop         | 类型                      | 默认值 | 说明                                                                           |
| ------------ | ------------------------- | ------ | ------------------------------------------------------------------------------ |
| `source`     | `StreamingMarkdownSource` | 必填   | 数据源。切换会话/消息时传入新的 source 实例即可，旧的会立即被替换。            |
| `throttleMs` | `number`                  | `50`   | 可见更新节流窗口（毫秒）。参考实现默认 50ms，推荐 50–120；`0` 表示不额外节流。 |
| `className`  | `string`                  | –      | 追加到根节点 `streaming-markdown` 之后的自定义类名。                           |

### `StreamingMarkdownSource`

| 成员                  | 说明                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| `append(text)`        | 追加一段流式文本。同微任务内的多次调用合并为一次通知与一次快照。                |
| `finish()`            | 结束流：同步提交剩余文本，`snapshot.finished` 变为 `true`。之后 `append` 抛错。 |
| `subscribe(listener)` | 订阅提交事件，返回取消订阅函数（供 `useSyncExternalStore` 使用）。              |
| `getSnapshot()`       | 当前快照 `{ text, revision, finished }`；未提交前引用保持不变。                 |

## 五条机制的落点

| 机制                             | 实现                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1. Source/Reader 分离            | `source.ts`：文本缓冲区与通知；组件只消费快照并渲染解析结果。                                         |
| 2. 合并快速更新后再解析          | `source.append` 用微任务合并，同一微任务只提交一次快照（`streaming-markdown.test.ts` 有断言）。       |
| 3. 可见更新节流（50ms，可调）    | `throttle.ts` + `StreamingMarkdownView.throttleMs`：窗口内只保留最后一次提交；`finish` 立即 flush。   |
| 4. 增量解析 + 稳定块复用（核心） | `blocks.ts` 按空行/围栏代码块切块；`incremental.ts` 以内容哈希缓存已完成块的 HTML，只重解析尾部块。   |
| 5. finish 后最终全量解析         | `incremental.finalize`：用 marked 顶层 token 重新切块并逐块全量解析；结果与一次性解析全文逐字节一致。 |

`finish` 后块列表按顶层 token 边界重建：流式阶段被空行拆开的松散列表、跨空行的 HTML 块等会恢复为正确结构。React key 来自块内容哈希 + 重复序号（`hash:occurrence`），尾部增长不改变已完成块的 identity。

## 解析器选型

- 评估了 npm 包 [`streaming-markdown`](https://github.com/thetarnav/streaming-markdown)（stm，MIT，0.2.15，unpacked ≈ 80KB）：它是**命令式**增量解析器，API 为 `parser(renderer)` + `parser_write(chunk)`，由调用方提供渲染器并逐块修改 DOM/节点。它不产出 HTML 或块边界，也没有 block 级缓存、SSR 或测试入口；接入 React 需要自建 DOM renderer 并绕过 React 渲染，与稳定 key、块级 memo 的目标相反，故未采用。
- 采用仓库已有的直接依赖 `marked`（Desktop 已在 `apps/desktop/package.json` 声明）：`lexer` 提供顶层 token 与精确块边界，`parse` 提供单块/全文解析；零新增依赖、零 lockfile 变更。

## 安全策略

解析输出沿用 Desktop 现有 Markdown 策略：

- 原始 HTML token 被丢弃，不会进入 `dangerouslySetInnerHTML`；
- 非 `http(s):` / `mailto:` / `#` 的链接渲染为惰性文本；
- 图片渲染为 `[图片：alt]` 占位符，不发起网络请求；
- 文本经 `sanitizeMarkdownText` 清理控制字符与 `\r\n` 归一化。

`StreamingMarkdownView` 用 `dangerouslySetInnerHTML` 渲染**经过上述策略的** HTML；接线时不需要也不应再叠加一层 HTML 注入。

## 已知边界

- 流式阶段按空行切块，是**近似**结构：松散列表可能暂时显示为多个列表、跨空行的 HTML 块会按段落显示。`finish()` 的最终全量解析会纠正。
- 流式阶段每次更新重新扫描全文做切块（O(n)），解析开销只落在尾部块；配合 50ms 节流，长文档仍为毫秒级。
- 引用式链接定义（`[ref]: url`）是文档级语义，最终解析自动回退为整篇解析（单块渲染）。

## 后续接线（不在本 PR）

对话页流式渲染处保持一个 `StreamingMarkdownSource`：

1. 每个 assistant 文本增量回调 `source.append(delta)`；
2. 本轮结束时 `source.finish()`，并换一个新 source 给下一轮；
3. 用 `<StreamingMarkdownView source={source} />` 替换当前 `MarkdownText` 的流式路径；
4. 现有 `MarkdownText` 的媒体/artifact 组件策略如需保留，可在接线 PR 中通过组件级 props 扩展，而不是改本模块的块级渲染。

## 测试

`tests/integration/desktop/streaming-markdown.test.ts`（node:test，随现有 integration shard 运行）：

- 任意 chunk 边界的增量最终 HTML 与一次性解析全文一致；
- 块哈希稳定、重复块 key 唯一；
- 已完成块只解析一次、尾部块随内容重解析（可观测调用次数）；
- 代码块内空行/跨 chunk 不切块；
- `finish()` 触发一次全量解析并修复流式近似结构；
- 引用式链接回退、安全策略、控制字符清理；
- SSR 渲染、节流窗口合并与默认间隔。
