# 追踪面板视觉验收

final result: passed

## 对照证据

- 设计基准：[用户选定的 UI 图](docs/assets/inspector/design-reference.png)，1254 × 1254 像素。
- 实现：打包后的 Pico macOS 应用，浅色主题，同一会话、同一次 `grep` 的展开状态与总览。
- [同屏对照](docs/assets/inspector/design-comparison.png)：依次为设计时间线、实际时间线、设计总览、实际总览。
- [步骤详情](docs/assets/inspector/timeline-inline-desktop.png)、[时间线](docs/assets/inspector/timeline-desktop.png)、[总览顶部](docs/assets/inspector/overview-desktop.png)、[累计与历史](docs/assets/inspector/overview-history-desktop.png)。

桌面截图原始尺寸为 1316 × 768；提交的截图仅裁取追踪面板 `(874, 90)–(1316, 768)`，尺寸 442 × 678，避免包含左侧会话正文。设计左右面板分别裁取 `(48, 81)–(613, 1247)`、`(641, 81)–(1207, 1247)`，等比例缩至 442 像素宽后并排比较。桌面捕获包含系统缩放，未将捕获像素冒充 CSS 像素或声明精确 deviceScaleFactor。另用 Electron 实测 320、480、640 CSS 像素宽的布局。

原图是长面板设计板，实际窗口高度较小；对照用于检查共同可见区域，下方内容以滚动后的独立截图验证。动态输入保留了真实的 `glob`、`line_number` 和绝对路径，因此比示例更长。缓存上报不完整时采用真实数据的两段环图，不复制示例的三段比例。以上差异不作为像素偏差评分。

## 检查结果

| 项目           | 结论与证据                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字体与层级     | 复用桌面系统字体；正文约 14px、区域标题 16px、重点数值 20px。实际截图中的轮次、步骤名、时长和正文层级清楚；长 JSON 换行，未挤压数值列。设计图没有可复用的字体文件，不声称字形逐像素一致。 |
| 间距与布局     | 页签固定在上方，运行分隔线、细线时间轴与原地详情符合选图。左右对齐的耗时可扫描；总览按请求、累计、当前历史分区。以各面板裁图作为聚焦检查，正文和图例均可辨认，无需额外局部放大。          |
| 色彩与状态     | 紫色页签和轮次、绿色成功、失败文字与语义颜色保留。复用宿主色彩变量，避免孤立主题。12 组宽度／主题／页签检查中，可见普通文字的最低实测对比度为 4.95:1。                                    |
| 图形与图标     | 设计不含照片或插画；复用现有图标库与由真实数值生成的 SVG 环图。未将设计图嵌入产品界面，未使用静态图片伪装统计。                                                                           |
| 文案与数据     | 保留“最近成功主请求”“累计耗时”“当前模型历史”的不同时间口径；未知费用、部分计量和不完整缓存提示可见。真实数据与示例数值差异明确。                                                          |
| 交互与可访问性 | Electron 验证键盘切换、页签独立滚动、重复点击收起步骤、关闭运行清除详情、刷新保留手动状态、切会话丢弃迟到结果。320px 宽下未出现横向溢出。                                                 |

## 修正与复验

1. P2：通用 `.tool-panel` 样式覆盖追踪面板的间距与字号。已提高面板根选择器优先级；最终桌面截图确认实际字号、页签和区域间距生效。
2. P2：初轮 Electron 检查发现“运行中”文字的蓝色对比度不足。已改用语义强调色；最终 12 组复验的普通文字对比度均高于 4.5:1。
3. 上述修正后的截图已与原设计放在同一张对照图中复查。没有剩余可执行的 P0／P1／P2 视觉问题。

## 验收清单与限制

- [x] 设计图与真实应用同屏比较，完成字体、间距、色彩、图形和文案检查。
- [x] 实际桌面检查时间线展开、总览及滚动后的模型历史。
- [x] 320／480／640px、浅色／显式深色、两页签共 12 组布局验证。
- [x] 类型检查、相关集成测试与桌面打包，详见[验证记录](docs/features/inspector-panel-validation.md)。

当前桌面产品仍为浅色；深色是显式宿主主题下的组件验收，不代表新增全应用深色开关。本次没有进行完整屏幕阅读器或系统字体放大审计，也没有改变模型执行链路。


# 命令菜单视觉验收（2026-10-01）

final result: passed

设计基准为用户提供的 Maka 菜单截图，932 × 790 像素。实现为重新安装的 Pico macOS 应用，浅色主题，输入 `/` 并选中 `aihot`。实际截图为 3024 × 1766 像素，对应约 1512 × 883 CSS 像素窗口。两者菜单裁图保留相同的 836 像素宽度，未缩放；参考截图的显示密度未独立测量。

- [同屏对比](docs/assets/command-menu/menu-comparison.png)
- [修改前](docs/assets/command-menu/menu-before.png)、[修改后](docs/assets/command-menu/menu-after.png)

原排版中长说明挤压名称，导致名称换成多行，且每行重复显示 Skills 分类。已改为左侧独立图标列，右侧两行文字：首行显示名称与灰色等宽命令，下行显示单行省略说明；分类标题只显示一次。复查同屏裁图，名称、图标、说明保持对齐，选中项使用浅灰圆角背景，列表采用统一宽度与滚动区域。

Pico 保留自己的六个常用命令与底部键盘提示，因此菜单高度和命令文案不同于参考图。图标复用 Lucide，字体与色彩复用桌面主题。此次没有单独进行深色和窄窗口的像素对比，也不声称完整像素复刻。

最终状态通过既有 Chrome／Electron 命令菜单集成验证（2/2）、相关 ESLint、renderer TypeScript 检查和桌面打包。安装后通过 computer use 打开菜单并检查键盘选择与 Skills 显示，未发送模型请求。此次不修改命令执行或资源标签协议。


## 自有图标修订（2026-10-01）

final result: passed

按用户最新要求，菜单图标改为 Pico 自绘 SVG：22 个命令及 Skill、Agent、参数、通用命令共 26 个字形。统一 24px 坐标、1.6px 圆角线条和 18px 显示尺寸，使用 currentColor 继承主题；该菜单不再使用上文记录的 Lucide 图标。保留已有的两行排版和命令行为。

重新打包并安装后，通过 computer use 查看命令与 Skill 列表、使用方向键选中 aihot，确认图标、文字和选中背景正常显示。[桌面效果](docs/assets/command-menu/menu-icons.png)。Chrome／Electron 既有集成测试 2/2、相关 ESLint、renderer 类型检查及桌面打包通过。只核查了浅色主题的实际 18px 显示，没有额外进行全主题图标审计。


## 输入框几何与诊断徽标（2026-11-25）

final result: passed

对话页的“最近记录诊断”徽标原本作为正文流内的最后一个面板，随消息滚动并推挤正文；运行状态出现时，模型、权限、思考强度等底栏控件换到第二行，输入框在空闲态与运行态之间跳动 34px。现把徽标改到输入卡片上方的绝对定位槽位，不占布局；底栏永久预留两行控件槽位，动态状态文字省略而不换行。renderer 单独 dev server（`vite --config vite.renderer.config.ts`，`?demo=1` 预览数据）在 1280×800 CSS 像素下量测：

| 状态     | 修改前 dock / composer / 输入框顶边 | 修改后 dock / composer / 输入框顶边 |
| -------- | ----------------------------------- | ----------------------------------- |
| 空闲     | 142 / 116 / 710px                   | 176 / 150 / 676px                   |
| 运行中   | 176 / 150 / 676px                   | 176 / 150 / 676px                   |
| 4 行草稿 | 202 高，底栏仍贴卡片底边            | 202 高，底栏仍贴卡片底边            |

- [修改前·空闲](docs/assets/composer-stable/before-idle.png)、[修改前·运行中](docs/assets/composer-stable/before-running.png)
- [修改后·空闲](docs/assets/composer-stable/after-idle.png)、[修改后·运行中](docs/assets/composer-stable/after-running.png)
- [诊断徽标钉在输入框上方](docs/assets/composer-stable/tag-pinned-empty.png)、[多行草稿时仍钉在卡片上方](docs/assets/composer-stable/tag-pinned-multiline.png)

徽标槽位 `getBoundingClientRect` 为 `y=587, h=40`，卡片顶边 `y=632`（间隔 5px）；徽标挂载与卸载时 composer 与输入框矩形完全一致，正文流内不再出现 `[aria-label="最近记录诊断"]`。新增 `tests/integration/desktop/desktop-composer-geometry.test.ts` 覆盖徽标出现/消失、空闲/运行、空草稿/换行草稿四类几何对比，去掉底栏预留后该测试以 34px 跳动失败。



## 运行态底栏独立槽位（2026-11-25）

final result: passed

发送消息进入运行态后，状态文字、行为选择器和暂停/停止按钮会与模型/权限/思考强度控件争抢同一行宽度；长模型名和排队提示把控件行压到约 484px，思考强度 `max` 与权限选择器被挤到第二行（`max` 掉底），空闲态与运行态的底栏排布不一致。现把底栏改成常驻两行：第一行固定放附件、菜单、模型、上下文、权限、思考强度等控件与发送按钮，第二行专用于运行态行为选择器、状态文字和暂停/停止，三态都不改变第一行宽度与成员。

在 800px 宽输入卡片（1000×700 视口）下用 `getBoundingClientRect` 量测，修改前后 `max` 控件的顶边与控件行高度：

| 状态   | 修改前 max 顶边 / 控件行高 | 修改后 max 顶边 / 控件行高 |
| ------ | -------------------------- | -------------------------- |
| 空闲   | 627 / 28px                 | 610 / 28px                 |
| 运行中 | 644 / 62px                 | 610 / 28px                 |
| 发送中 | 627 / 28px                 | 610 / 28px                 |

修改后空闲、运行、发送三态的控件行成员（附件、加号、模型、上下文用量、权限、思考强度、模式徽标）、逐项 `x/y/w/h`、发送按钮，以及 composer/输入框矩形完全一致；运行态状态行独占 `y=644, h=28`，不再压缩第一行。附件按钮在运行态也保留在原位，页面不再因运行状态移除该控件。

- [修改前·空闲](docs/assets/composer-running/before-idle.png)、[修改前·运行中](docs/assets/composer-running/before-running.png)、[修改前·发送中](docs/assets/composer-running/before-sending.png)
- [修改后·空闲](docs/assets/composer-running/after-idle.png)、[修改后·运行中](docs/assets/composer-running/after-running.png)、[修改后·发送中](docs/assets/composer-running/after-sending.png)

截图由 headless Chrome 渲染与集成测试相同的 composer 场景后裁取输入卡片区域，比例 2×（1640×320 像素）。`tests/integration/desktop/desktop-composer-geometry.test.ts` 新增三态 DOM 几何断言；回退本次 CSS 后该用例在“运行态控件使用独立行”处失败，量测到控件行高 62px、状态行与控件同行。renderer 类型检查（应用 `patches/` 后）通过。
