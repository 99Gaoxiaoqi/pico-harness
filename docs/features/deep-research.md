# 深度研究与交付预览

研究工作流使用 Pico 的 Session、SQLite、权限边界和 Artifact 工作栏。研究领域代码归属见 `resources/licenses/THIRD_PARTY_NOTICES.md`。

## 使用入口

Desktop 输入框的 `+` 菜单选择“深度研究”；TUI 使用 `/mode research`。新任务提供快速、标准、深挖三个研究起始提示。不指定范围时默认标准。

研究模式保存到 Session，重启后恢复。它只披露 read_file、glob、grep、web_search、ask_user 及八个研究工具；Web Search 仍服从已配置的搜索来源与权限，不会自动取得联网授权。Shell、Code Mode、MCP、插件 hooks、LSP、Graph/Swarm 和子代理不在此模式内启动。选择 full-access 也不能绕过研究模式的工具守卫。研究工具仅写 Pico 管理的状态与产物，不写用户项目文件。

## 完整工具体系

| 工具                           | 职责                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| deep_research_start            | 固定本次研究目标与 quick / standard / deep 范围，初始化四项检查和五个报告章节                          |
| deep_research_save_artifact    | 保存 source、evidence_note、outline、report_section、report、handoff；来源有定位符，派生材料有来源引用 |
| deep_research_read_artifact    | 按 Unicode 字符有界回读当前 Session 的研究材料，默认 32K、最多 64K 字符                                |
| deep_research_update_checklist | 更新项目入口、核心链路、边界条件、验证证据；完成须有证据，阻塞或跳过须说明原因                         |
| deep_research_record_step      | 记录本地探索或网络研究的范围、忽略项、停止条件、检查过的引用及证据                                     |
| deep_research_checkpoint       | 保存轮次、阶段、开放问题、下一步及恢复所需材料引用                                                     |
| deep_research_status           | 恢复进度；可通过 artifact_offset / artifact_limit 分页找到上下文之外的历史材料                         |
| deep_research_complete         | 检查完成门，保存最终报告和实施交接                                                                     |

研究分为证据库和报告撰写两个阶段。完成要求四项检查已完成或明确跳过、五个报告章节完成、报告与交接材料已持久化，以及可执行任务、建议 Issue/PR、验证命令。状态与 Artifact 在同一 SQLite 事务提交；相同调用幂等，不同内容不能冒充旧调用。不同 Session 的研究材料不可互读。

Desktop 进度卡展示当前阶段、轮次、检查项、报告进度、阻塞、最近检查点和来源；“查看证据与报告”打开产物工作栏。完成后“新建实施任务”把有界交接说明发送到新的 agent 会话，原研究会话保留只读模式。

## 产物预览范围

- Markdown 渲染 / 源码切换，普通文本、diff / patch。
- HTML 沙箱内联脚本交互；不允许访问父页面、网络、弹窗或外部导航，依赖外链 CDN 的页面需自包含资源。
- PNG、JPEG、GIF、WebP、AVIF 图片，PDF 内嵌预览。SVG 不作为可执行图像加载。
- 文本预览上限 256 KiB，图片 2 MiB，PDF 16 MiB；超限保留打开/另存入口。Blob URL 在切换和卸载时释放。

此范围针对已登记的 Artifact，不增加图片生成或扫描 Shell 输出的自动登记行为。

## 验证入口

- `tests/integration/runtime/deep-research-tools.test.ts`：持久化主路径、恢复分页、完成门、隔离与幂等。
- `tests/integration/runtime/deep-research-host.test.ts`：Desktop 模式与进度协议、重启、实际工具执行守卫和进度渲染。
- `tests/e2e/deep-research.real-llm.test.ts`：真实模型两轮研究、回读与报告收口，验证项目文件不变。
- `tests/integration/desktop/desktop-artifact-preview.test.ts`：真实 Electron 交互及隔离验收；设置 `PICO_TEST_ELECTRON` 指向 Electron 可执行文件，未配置时对应测试明确 skip。

统一评测实验层的矩阵、续跑、指标口径和 Code Mode 命令见 `scripts/eval/README.md`。本次对齐没有替换既有 Terminal Bench 执行器。
