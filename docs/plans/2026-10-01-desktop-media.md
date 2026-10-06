# 桌面图片与视频展示计划

日期：2026-10-01。状态：P1 图片与 P2 短视频已完成、打包重装并通过验收；P3 待后续开发。开发基线：`main 3a792143`；最终本地 `main 84a120d6`。

## 目标与首版范围

Agent 产出或引用已授权的本地图片、短视频后，聊天正文直接展示，文件面板使用相同预览组件；重新打开历史会话仍能查看，并可另存原文件。仅含媒体、没有正文的消息也必须保留。

第一轮开发包括下述 P1 图片与 P2 短视频。P3 大视频流式播放单独交付。图片／视频显示是客户端能力，不要求模型能够理解视频，不改变 Provider 的多模态输入协议。

输入框粘贴／拖入图片、远程媒体下载、视频转码、SVG 主动内容预览不纳入第一轮。远程媒体先保留链接／占位，后续单独接入受现有网络策略约束的加载流程。

## 参考实现与已验证事实

### Codex

官方 App Server 文档明确区分 `text`、`image`、`localImage` 输入，提供 `imageView {id, path}` 事件，并通过 `item/started`、`item/completed` 管理条目生命周期。可借鉴“媒体有独立类型和稳定身份，消息完成态可恢复”的协议思路。

官方公开文档没有说明桌面视频播放器内部的文件授权、缓存和 Range 实现；不能据此声称已复现 Codex 的内部媒体服务。这里也不把模型视频输入能力当成客户端播放能力。

来源：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，Turns 和 Items 小节。Codex 在当前宿主中支持本地媒体 Markdown 展示属于产品约定，不据此推断其私有实现。

### 本地参考客户端

- 聊天图片识别会话附件 URI，通过当前会话上下文读取 Artifact，图片读取上限 2 MiB；不直接允许 Markdown 任意本地文件路径。出处：Maka 仓库 `packages/ui/src/markdown-body.tsx:274`、`attachment-image.tsx:45`、`apps/desktop/src/main/runtime-host-artifacts-ipc-main.ts:185`。
- 原始路径通过主进程的一次性批准句柄转为附件；文件读取检查会话归属和真实路径范围。出处：`apps/desktop/src/main/attachment-approval.ts:23`、`packages/storage/src/artifact-store.ts:910`。
- 未发现聊天视频组件或浏览器 Range 媒体服务。其内部 32 KiB 分块导出不等于视频流；HTML 临时预览租约仅能借鉴 TTL、撤销和释放原则。
- 图片组件允许 HTTP(S)，但桌面 CSP 的 `img-src` 未放行这些来源。静态源码显示规则不一致；本次未对参考 App 做 UI 验证，不能称远程图端到端可用。

仅只读参考架构，不复制源文件或改动参考仓库。

### Pico 当前缺口

- `apps/desktop/src/renderer/conversation/MarkdownText.tsx:35`：图片为文本占位，原始 HTML 被过滤。
- `packages/core/src/message.ts:86`：引擎已有 ImagePart；`packages/protocol/src/runtime/transcript.ts:190` 未定义消息媒体引用。SQLite durable projection 和 renderer 会丢弃媒体内容／空正文消息，故只改 img 标签不足以完成展示。
- `apps/desktop/src/renderer/workbar-panels/ArtifactPreview.tsx:125`：已有图片 Blob URL、签名检查与释放，可复用；预览图片上限 2 MiB，PDF／二进制解码上限 16 MiB。
- `packages/pico-host/src/session-artifact-writer.ts:13`：工具产物发布仅接收 UTF-8 字符串；已有 Artifact 二进制底层不代表 PNG／MP4 已能自动登记。
- `packages/storage/src/sqlite/sqlite-session-workbar-repository.ts:229`：每次 append 读取并重写完整 ingest；`:411`：每次 read_chunk 读取完整 SQLite Blob 后裁取。两者都会随着视频大小明显放大复制成本。
- `apps/desktop/src/main/artifact-preview-security.ts:30`：隔离 HTML 子框只允许 blob/data 等本地资源；不能为了视频给整个子框放开文件或网络访问。

## 采用的链路

`工具产物／授权文件 → Host 媒体登记 → 会话 Artifact + 消息 media 引用 → Transcript → 共用媒体组件 → 聊天与文件面板`

持久引用包含 `artifactId / kind / alt / mimeType / sizeBytes / digest`，兼容来源映射 `source`。真实文件字节留在 Artifact；临时 Blob URL 和大段 base64 不写进 Transcript。视频采用自己的 `kind: video`，不放入模型 ImagePart。

Host 接受已存在的 Artifact 或经授权的工作区文件，检查会话、允许根目录、realpath／打开文件后的信息、文件签名、大小与摘要；不能因回复里出现绝对路径就授权访问整个磁盘。外部文件需已有明确授权；失败保留可理解的占位／文件卡片。

推荐内部链接 `pico://artifact/<artifactId>`，由组件注入的 workspace/session 上下文解析，不直接交给浏览器访问。兼容 `![说明](/绝对路径/image.png)` 和明确的视频文件链接时，由 Host 在消息定稿阶段登记并绑定稳定引用，原始模型文本保留。普通 Markdown 链接保持链接行为；视频转换必须是已验证的媒体引用，不按任意网址后缀直接播放。

已进入消息的 base64 ImagePart、回复引用的授权本地文件或现有 Artifact 在同一登记链路中归一化；远程 image_url 首版不自动下载。工具产物需要由回复引用后进入正文预览，首版不把任意工具文本当作媒体。媒体注册不在 SQLite projector 内进行文件 I/O。

新增公开契约集中在媒体登记／引用与投影。优先复用 `session.artifacts.query/command`、Artifact saveAs 和现有会话权限；具体接口名称在开发时按当前命名规范确定。发布、消息绑定必须有幂等键，避免重连或重放创建重复 Artifact。

## 实施顺序与验收

| 阶段 | 开发内容 | 完成标准 |
| --- | --- | --- |
| P1 图片闭环 | 增加二进制产物发布、可选 media 引用和投影；保留空正文媒体消息；共用图片组件、按需加载、点击放大、状态占位；聊天／文件面板／另存复用读取；增加消息定稿时的本地路径兼容。首版沿用 PNG/JPEG/GIF/WebP/AVIF 和 2 MiB 预览限制，超限提示并保留导出。 | 图片产出后在正文展示，文件面板一致；应用重启和会话切换后仍恢复；原路径被修改／删除后已登记的不可变快照仍可查看；另存摘要一致。 |
| P2 短视频闭环 | 目标为 MP4（H.264/AAC）和 WebM（VP8/VP9/Opus），以打包 Electron 实测为准；拟定 16 MiB 内嵌限额。首先改为数据库范围读取，避免每块重取整包；登记使用有界二进制快照直接写入，避免 32 KiB append 反复拼接整份视频，原分块 RPC 保留兼容。共用 `<video controls preload="metadata">`，不自动播放；Blob URL 在切换、卸载时释放。 | 视频可播放、暂停、拖动、全屏，切会话停止播放并释放；历史恢复；超限和不支持 codec 时可另存。回归确认现有 Artifact 幂等、摘要、图片和 PDF 行为保持。 |
| P3 大视频流式读取 | 主进程签发短期 opaque 媒体 URL，绑定窗口／会话／Artifact，renderer 不得到任意文件读取 API。自定义 scheme 支持只读 GET/HEAD、单段 Range 和取消；200/206/416、Content-Length/Content-Range 正确。采用经校验的不可变磁盘缓存或真正的范围读取，不把整段视频 base64 往返 IPC。 | 大视频按需加载，拖动能读取对应区间；取消立即关闭流；切会话、删除产物、窗口销毁、TTL 到期均撤销 URL；未授权请求与非法 Range 失败且不泄露内容。 |

图片 2 MiB／短视频 16 MiB 已作为首版登记与预览限额实施。现有 Artifact 超限可从文件面板另存；超限的本地路径引用不会自动登记成 Artifact。较大的图片可以后续通过缩略图提升预览体验，存储与预览限额分别控制。

Electron 官方 `protocol.handle` 支持响应流，自定义协议可设置 `stream: true`；协议按 session 注册。只开启需要的权限，不启用 bypassCSP，不改变隔离 HTML 子框的资源限制。来源：[Electron protocol 文档](https://www.electronjs.org/docs/latest/api/protocol)。

## 验证清单

- 本地确定性集成：工具／发布器登记图片和短视频 → 消息绑定 → Transcript → Electron 正文和文件面板展示 → 重开／重启恢复 → 另存摘要一致。不为本地播放特意调用真实模型。
- 兼容性：旧消息仍显示；媒体单独消息保留；流式正文到完成态媒体不重复；中断／登记失败不让整个会话失败；projector version 与缓存重建遵循现有连续性契约。
- 核心失败路径：跨会话 Artifact、越权路径／链接越界、错误 MIME／签名、摘要异常、缺失文件、超限；迟到结果不串会话，失败提示可恢复。
- 生命周期：会话删除、归档与 fork 必须定义引用语义；新媒体不遗漏现有导出／保留／GC 流程，不能撤销 Blob URL 后使另一窗口失效。
- 安全回归：原始 HTML、危险链接、隔离 HTML 联网／文件访问限制保持；媒体读取沿用现有权限，不扩大 Provider 或 Agent 工具权限。
- P2 在正式打包 App 测 codec 和内存／读写开销，确认不存在每分片整包读取或写回；P3 另测 Range、seek、取消与并发上限。
- 最后重新安装 App，computer use 检查图片放大、视频播放／拖动、历史恢复与另存。

## 协作与回退

开始开发后，公共 media 契约、存储与投影由一名所有者串行处理；契约明确后，组件／预览与 Host 媒体读取可拆成不共享文件的任务。主代理集成并运行上述验收，不同时修改公共 schema、锁文件或生成物。

协议采用可选媒体字段以兼容历史；已有文本产物 API 保留。存储变更须按现有迁移与数据保留约定实现。故障时关闭媒体组件回到占位与另存入口，不删除已保存媒体，也不回滚共享历史。

公共契约由主代理维护；Host 登记／存储投影与桌面组件分别在独立分支完成，已在独立集成分支验证并快进合入本地 main。未提交用户已有文档、未推送 main，也未改动参考仓库。

## 最终验收记录

- 38 项相关测试通过且无跳过：持久化与兼容 30 项、真实 Electron 媒体 2 项、现有预览／Markdown 安全回归 6 项。桌面 typecheck、相关 ESLint、架构边界检查、正式打包通过。
- 已安装本机 Pico.app；computer use 验证正文图片放大、MP4/WebM 播放与暂停、进度跳转、视频全屏、文件面板预览和图片另存。
- 移走验收原文件并重启 App 与 Runtime 后，历史媒体仍恢复；另存图片与登记原图 SHA-256 一致。验收使用本地确定性 Provider，未发送真实模型请求。
- 只为新定稿消息登记媒体；旧历史中未登记的链接不会自动补读本地文件。远程下载、输入框粘贴／拖入、超限视频流式播放和转码仍在首版范围外。
- 详细日志、截图、限制与已有问题留存在本地 `output/desktop-media-20261001/`，未纳入仓库。
