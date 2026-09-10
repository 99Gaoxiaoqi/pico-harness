# 子智能体技术文档配图

正文见 [PiCO 子智能体技术图解](../../pico-subagents-technical-guide.md)。

| 资源                         | 用途                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `cover.png`                  | 内置 image_gen 生成的概念封面；提示词见 [生成记录](cover-prompt.md) |
| `identity.mmd` / `.png`      | 配置、会话、运行与卡片的关系                                        |
| `configuration.mmd` / `.png` | 配置保存、发现与启动前校验                                          |
| `execution.mmd` / `.png`     | 持久子任务执行时序                                                  |
| `continuation.mmd` / `.png`  | 主智能体续用校验                                                    |
| `permissions.mmd` / `.png`   | 统一能力恢复与权限限制                                              |

五张技术图由 Mermaid CLI 11.17.0 渲染，白色背景、2 倍比例；样式在 `mermaid-config.json`。PNG 供普通 Markdown 阅读器使用，`.mmd` 是可编辑源文件。技术图没有使用生图模型生成文字或箭头。

已具备 Mermaid CLI 与可用 Chromium 的环境，可在仓库根目录重新导出，例如：

```bash
mmdc -i docs/images/pico-subagents/identity.mmd \
  -o docs/images/pico-subagents/identity.png \
  -c docs/images/pico-subagents/mermaid-config.json \
  -b white -w 1800 -s 2
```

若使用系统 Chrome，可按 Mermaid CLI 的 `-p` 参数提供本机 Puppeteer 配置；不要将本机浏览器绝对路径写进项目配置。
