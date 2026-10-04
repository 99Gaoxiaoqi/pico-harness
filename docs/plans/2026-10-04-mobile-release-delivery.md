# 移动端发版整改交付记录

日期：2026-10-04。阶段一、二代码整改完成；阶段三交付内部候选，尚不具备正式发版条件。

## 代码结果

- 恢复同步增加 `syncRevision`；首批 replay 在可请求状态和页面提交后交付，电脑/工作区的 `generation` 围栏与命令恢复锁保留。设置、会话操作、工作栏、文件、终端恢复时重读最新快照；未提交编辑与原 revision 保留，终端不会重建或重发输入。
- 配对 claim/token 仅保存在 SecureStore 待确认记录中。网关确认先落盘再发布 `pairedAt`；明确 ack 或已确认设备认证之后才保存正式电脑。重启、后台、回执丢失继续原申请；取消和数据清理也覆盖 submit 尚未回执的窗口。
- 同协议新增未知方法只被过滤，身份、版本、权限与预算仍严格校验。已发命令的坏响应保持“结果未确认”；本机断线拒绝明确为 `not_executed`。确认和撤销仅接受明确 `true` 回执，不显示假成功。
- 两种按电脑清理入口分别保留/删除凭据；未确认恢复记录须明确放弃。草稿、审阅、下载采用代次与写队列屏障，清理失败不报完成，迟到响应不复活，其它电脑保留。无法辨认归属的旧缓存单独确认清除。
- 离线未配对可读隐私与支持、版本与安全诊断；未配置的发布资料如实显示暂无。准备四步、权限拒绝后的粘贴/系统设置和按错误分类的恢复动作已接入。
- 双端重新生成并构建原生项目，无多余麦克风权限。Android 生成 Manifest 显式禁用明文网络；iOS 模拟器使用链接阶段嵌入的独立本地 Keychain entitlement，未生成正式 Apple 签名。

## 验证结果

| 检查                                 | 结果与边界                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `tests/integration/remote/*.test.ts` | 62/62 通过，0 skipped；覆盖传输、HTTPS/WSS 网关、配对确认/过期/重启、草稿/审阅恢复、清理、页面同步、终端、发布校验与离线入口   |
| 测试类型图修复后的本地清理回归       | 3/3 通过；仅调整测试类型边界，不改变产品行为                                                                                   |
| `RUN_LLM_E2E=1` 真实模型主路径       | 1/1 通过，0 skipped；真实 HTTPS/WSS 授权模型选择和流式中文输入完成                                                             |
| 手机类型检查、包构建                 | `mobile:typecheck`、`npm run build` 通过；双端 Hermes export 通过                                                              |
| 修改范围 lint/format、依赖边界       | 通过；原生生成物与产物不纳入源码提交                                                                                           |
| 根级 `tsc --noEmit`                  | 原工作区基线 208 条、最终集成 208 条，规范化诊断无新增；该检查仍失败，不能宣称全仓类型检查通过                                 |
| 独立聚焦审查                         | 已处理本机未执行、submit 尚未回执清理、撤销坏回执三个窗口；针对回归通过后停止                                                  |
| Android Native Release               | 0.1.1/code 2；内部 debug 证书签名，arm64-v8a/x86_64；包内 JS/资源、版本、实际 Manifest、签名指纹与产物 SHA-256 见候选 metadata |
| Android 模拟器启动                   | Android 15/API 35 arm64，同签名覆盖安装及无 Metro 冷启动通过；x86_64 只打包、未运行；没有正式旧版签名升级证据                  |
| iOS Native Simulator Release         | 0.1.1/build 2，arm64，iOS 26.5/iPhone 17 Pro 独立验证设备；冷启动、无 Keychain 读取错误、离线隐私/支持与版本显示通过           |
| Host/网关归档                        | 同一产品来源的 `pico-harness-0.1.0.tgz`，隔离解压 CLI `remote --help` 启动通过；未验证 Windows/Linux 原生安装                  |

Keychain 的应用身份与默认访问组必须由签名/构建正确提供，依据 [Apple 的 Keychain 访问说明](https://developer.apple.com/documentation/Security/sharing-access-to-keychain-items-among-a-collection-of-apps)。模拟器本地 namespace 不表示真实 Apple Team，不用于设备包。

## 候选来源与工作区保护

候选产品源码冻结在 `3fcaea45729e8a37dab84dc1e4a7517d46b6ddbf`。后续仅提交交付文档；准确产物摘要、签名、工具版本、来源差异与运行记录以 `output/mobile/release-remediation-2026-10-04/package-metadata.json`、`validation-result.json` 为准。

首批原生候选构建时，原工作区 App、Conversation、ComposerOptions、mobile-screen-recovery 测试与 design-qa 的未提交修改未覆盖、未暂存、未提交。该批原生候选不包含这些当时未提交的界面修改。后续界面任务已自行提交至 main 的 `c713a241`，本轮合并复验将其纳入整改分支；design-qa 仍保留原工作区未提交状态。

整改方案以独立提交交付，避免自动整理用户现有工作区。最终 Git 交付位置与目标分支处理结果以本轮回复为准。

## 尚未完成的发版条件

用户确认以下资源均暂无：真实发布主体、隐私/支持 URL、Apple/Android 正式发行签名、iPhone/Android 真机、可信公网网关。不能制作可安装 iPhone 的正式 IPA、正式 Android 签名/AAB，不能进行真机蜂窝验收或公开商店送审。当前商店模式应明确拒绝缺失资料。

| 真机矩阵                           | 当前状态                                                 |
| ---------------------------------- | -------------------------------------------------------- |
| 安装/正式签名升级/离线冷启动       | 真机未运行；只有上述模拟器安装和冷启动证据               |
| 蜂窝配对、过期/撤销/证书恢复       | 未运行；本地隔离 CA 的 HTTPS 集成不代替公网/蜂窝验收     |
| 真机模型/审批/审阅/成果闭环        | 未运行；真实模型通过仅指自动化主路径                     |
| 软件键盘、大字、Android 返回、读屏 | 真机未运行                                               |
| 相机/图库拒绝、拍照/选图、系统分享 | 真机未运行；仅入口集成和原生权限声明已验证               |
| 锁屏/后台/Wi-Fi 与蜂窝切换         | 真机未运行；本地生命周期与迟到围栏集成通过               |
| 未知结果、本机清理                 | 真机未运行；相关确定性集成通过                           |
| 长历史、旧/新完整设备版本组合      | 真机未运行；分页、恢复、同协议增量能力与拒绝降级集成通过 |
| IPv4/IPv6、三种电脑系统公开支持    | 真实跨网与 Windows/Linux 安装未运行，不声明已覆盖        |

取得资源后，只对同一最终正式候选执行上述矩阵，核对渠道最高构建号并补足审核隔离环境。已删除的本机数据不可通过回滚代码恢复；回滚代码不停止电脑任务或终端。

## 主分支合并复验

用户随后要求合并验证。合并前 main 前移至 `c713a24103045ec0ad02ab6da01f63af655dbd52`（会话布局与过程折叠）；独立整改分支无冲突集成为 `c6858fbb3eec05a042982beefde658f3d0faa500`，保留两边功能，再进行组合复验。

- remote/mobile 集成 65/65 通过，0 skipped，包含新会话布局、过程折叠、恢复与清理。
- 移动类型检查、依赖边界、包构建、双端 Hermes 导出及自动合并 App 的 lint/format 通过。
- 与最新 main 的根类型诊断逐项比对：双方均 208 条，新增 0、删除 0；根类型检查仍失败。
- 原 PR 与当时 main 的 CI 首次失败步骤一致：依赖审计均 30 项（5 moderate、25 high，22 个 advisory 相同）；Node 24/26 根类型诊断各 208 条且逐项相同。CI 失败后的集成/构建步骤未执行，不能声称 CI 全绿。证据：[PR CI](https://github.com/99Gaoxiaoqi/pico-harness/actions/runs/37150696131)、[main CI](https://github.com/99Gaoxiaoqi/pico-harness/actions/runs/37101980855)、[PR Desktop](https://github.com/99Gaoxiaoqi/pico-harness/actions/runs/37150696143)、[main Desktop](https://github.com/99Gaoxiaoqi/pico-harness/actions/runs/37101980889)。

本节仅代表最新组合代码的合并验证。此前 APK、iOS ZIP 的来源仍为 `3fcaea45`，没有重打包含新布局的原生候选，也没有追加真机或公网验收。不得将首批原生包的验收结果移植至新的主分支包。

PR 合并状态、最终 main 提交与本地同步结果见本轮最终回复和产物目录中的 `merge-validation-result.json`。保留所需产物后清理本任务临时 worktree，用户已有 design-qa 和其它未跟踪文件不纳入提交。
