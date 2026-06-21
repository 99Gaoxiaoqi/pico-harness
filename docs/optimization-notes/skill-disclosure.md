# Skill Progressive Disclosure 优化记录

## 当前 pico 实现思路

优化前 `SkillLoader.loadAll()` 会读取 `.claw/skills/*/SKILL.md` 的 name、description 和完整 body,全部注入 system prompt。优点是模型启动即可看到所有 SOP；缺点是技能稍多就会常驻消耗上下文。

## Hermes 对应实现思路

Hermes 使用 progressive disclosure:先展示技能清单,模型需要时再调用工具查看完整技能正文。这样 system prompt 更短,也避免无关技能稀释注意力。

## 优化后设计

- `SkillLoader.loadAll()` 只输出技能名称与触发条件。
- 新增 `listSummaries()` 和 `viewBody(name)`。
- 新增 `SkillViewTool`,工具名 `skill_view`,按名称读取技能正文。
- CLI 注册 `skill_view`,使 Plan Mode prompt 中的技能清单可按需展开。
- `parseSkillMD()` 改为只匹配开头 frontmatter,正文里的 `---` 不再误截断。

## 取舍说明

借鉴 Hermes 的“清单先行、正文按需”,但暂不做技能安装、技能创作、curator 后台维护。pico 先解决上下文常驻油耗问题。

## 油耗对比

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 有 10 个技能,每个 2KB | system prompt 常驻约 20KB 正文 | system prompt 只含 name/description |
| 使用单个技能 | 已经消耗全部技能正文 token | 仅 `skill_view` 读取目标技能 |

本模块会直接降低常驻 `promptTokens`,尤其是 Plan Mode 每轮重组 prompt 时收益更明显。

## 验证记录

- `tests/composer.test.ts`: 覆盖 summary-only、`skill_view`、frontmatter 精确解析。
- 已运行: 相关测试通过。
- 已运行: `npm run typecheck`,通过。
- 最终全量验证: `npm run typecheck`、`npm run lint`、`npm test`、`npm run build` 均通过;全量测试为 15 个测试文件、190 个测试。
