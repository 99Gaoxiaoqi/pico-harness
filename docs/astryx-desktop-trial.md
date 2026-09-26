# 桌面 Astryx 试迁移验收

本轮将 renderer 迁移到 Astryx 0.6.2；保留 Pico 浅色主题、系统字体、现有业务图标与数据路径。React、Electron、Vite 未升级。后端协议、模型行为和工作栏资源生命周期未改。

## 已迁移

| 范围                           | 实现与边界                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 外壳、侧栏、任务搜索           | AppShell surface、固定侧栏断点、单一 main；DropdownMenu、Dialog、TextInput                                  |
| 主聊天与侧聊                   | ChatComposer、ChatComposerInput；受控草稿、原提交门禁和 focus handle                                        |
| 消息布局                       | ChatLayout 唯一滚动容器；首次挂载起 autoScroll=false，Pico 保留 96px 跟随规则                               |
| Markdown                       | Astryx Markdown，自定义安全链接、图片文字占位、原代码样式；marked HTML token 过滤；不启用流式渐显           |
| 设置、Provider、任务页、工作栏 | Button、IconButton、TextInput、TextArea、Selector、Switch、CheckboxInput、Dialog、DropdownMenu、TabList/Tab |

原生输入仅保留两处非受控凭证 input（真实 ref、原清空语义）以及 Markdown 只读任务复选框。凭证保存失败也清空密码，这是迁移前的安全语义；普通表单失败保留草稿。业务 details/summary 继续保留。

## 必要补丁与样式约束

`patches/@astryxdesign+core+0.6.2.patch` 同时维护发布 JS、源码和新增 prop 的类型声明，`postinstall` 自动应用且失败中止。

- ChatLayout 增加默认 true 的 autoScroll，并转发到现有 scroll hook 的 enabled。
- 没有 onFiles 时，混合文件/文本粘贴继续插入纯文本。
- 纯文本粘贴进入 Chromium 原生编辑历史，支持撤销/重做。
- 排除浏览器末尾占位换行，识别多行粘贴的块边界；恢复末尾换行草稿时补回占位，保留纯空白草稿。

这些输入补丁均先在真实 Electron 复现后提取，没有复制 Maka 的整份修改。源码与发布包补丁已对 npm 原始 0.6.2 包重放并逐文件校验一致。

主题由 `npm run astryx:theme` 生成，`npm run astryx:theme -- --check` 验证无漂移。生成结果排除全局 typography reset。main.tsx 必须先导入 layers.css，以在任何组件样式注册前确立层顺序：reset → tokens → base → astryx-components → astryx-tokens → components → pages → utilities。

## 验证结果

- 受影响集中集成回归 107 项通过，补充 Web Search、Swarm、会话导航、思考展示与审批回归 15 项通过，无跳过。
- desktop typecheck（main、preload、renderer）与 renderer 生产构建通过；变更文件 ESLint、diff check 通过。
- Electron 聊天测试覆盖失败/成功草稿、Enter/IME 事件、完整 Shift+Enter 字符事件、连续换行、恢复尾部空行、长文本与混合剪贴板、选区替换、粘贴撤销/重做、侧聊、96/97px 跟随、回到底部及 resize。
- 独立 ChatLayout 探针确认关闭自动滚动时，挂载、追加消息及 resize 不产生库自身 scrollTop 写入。
- Chrome 场景覆盖侧栏搜索/菜单/焦点、任务表单、模型切换锁、审批交互、子 Agent 设置。Electron 工作栏场景覆盖待办修订、地址栏、终端输入、文件操作菜单；现有追踪、HTML 隔离与终端回归通过。
- 真实 Electron Provider 场景覆盖编辑失败保留草稿、成功和 ESC 焦点恢复、凭证 ref/清空、创建流程和 Selector 原生鼠标交互。
- 用真实 main/preload 和隔离 PICO_HOME 启动应用；生产 renderer 在 1280px、720px 下核对新任务、设置、Provider、聊天截图，原生点击权限菜单和搜索弹层。

截图差异：保留侧栏 226px（窄窗 220px）、折叠 62px、正文布局和输入器圆角/停靠；选择器箭头、焦点轮廓及弹层键盘高亮由 Astryx 提供。修复了迁移中发现的按钮标签嵌套、hidden 覆盖、样式层顺序和凭证关闭焦点回归。基线与最终截图跨越下午/晚上，欢迎语随原有时间逻辑变化，徽标原蓝色保持不变。

## 未通过项和验证边界

以下问题已核对迁移前 main 的同一实现，属于既有问题，本轮未扩大范围修复：

- 原生 WebContentsView 会遮挡工作栏右键菜单和全局搜索弹层；真实 OS 截图已确认。CSS z-index 无法解决，需要单独设计 overlay 可见区域协调，不能通过销毁浏览器实例规避。
- 浏览器面板没有消息条时，原三行 grid 使 viewport 仅约 160px 高。
- 960px 窄窗同时展开右栏和底栏时，既有最小高度可能导致重叠。

自动化验证了 IME composing/229 Enter 门禁，未进行系统中文候选窗的完整人工输入验收。完整 demo 应用的示例项目路径不存在，终端仅验证错误/空态几何；真实 PTY 行为由既有终端集成回归覆盖。原窗口最小宽度 960px 未改变，720px 是 renderer 布局测试。

## 回退

AppShell、聊天、Markdown、页面、设置和工作栏分组提交保留在历史中。按组件撤销对应实现时，同时撤销其 main.tsx CSS 导入和相关适配测试；仅在聊天不再使用 autoScroll/input 补丁后移除对应 patch hunk。公共主题和控件最后回退。不要直接改生成主题或 node_modules 作为持久修复，不要回退后端或用户数据。
