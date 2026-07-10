# Claude Code 风格 Skill 与 Workspace 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）逐任务实现此计划。步骤使用复选框（`- [x]`）语法来跟踪进度。

**目标：** 让显式 Skill 成为可观察的执行指令，并用 additional directories 统一解决工作区外文件访问与审批能力错位。

**架构：** Skill 侧新增纯渲染模块，由 command registry 注入 synthetic user prompt；路径侧新增共享 `WorkspaceRoots`，所有文件工具和 `/add-dir` 持有同一实例。确定性路径校验先于审批，审批只负责已授权目录中的写动作。

**技术栈：** TypeScript、Node.js `fs/promises`、Ink/React、Vitest、现有 CommandRegistry/ToolRegistry/SessionSettings。

---

## 文件结构

- `src/input/skill-activation.ts`：Claude Code 风格参数展开与激活 prompt。
- `src/tools/workspace-roots.ts`：主工作区/additional directories 的规范化、去重与路径能力判断。
- `src/input/add-directory.ts`：配置读取和 `/add-dir` 所需的目录管理接口。
- `src/input/markdown-command-loader.ts`：将 Skill command 路由到激活渲染器。
- `src/input/pico-command-registry.ts`：注册 `/skill`、`/<skill-name>` 与 `/add-dir`。
- `src/input/session-settings.ts`：保存 session additional directories。
- `src/tools/registry-impl.ts`、`glob.ts`、`grep.ts`、`default-registry.ts`：共享 Workspace Roots。
- `src/cli/main.ts`、`run-agent.ts`、`src/tui/repl.tsx`：启动参数、运行时接线与 transcript 事件。
- `tests/e2e/skill-workspace-real-llm-e2e.test.ts`：真实模型验证显式 Skill 与 additional directory。

### 任务 1（Agent A）：Skill 激活渲染核心

**独占文件：**
- 创建：`src/input/skill-activation.ts`
- 修改：`src/input/markdown-command-loader.ts`
- 创建：`tests/input/skill-activation.test.ts`
- 修改：`tests/input/markdown-command-loader.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
it("wraps an explicitly activated skill as instructions", () => {
  const result = renderSkillActivation({
    name: "review",
    args: "src/a.ts",
    body: "Review $0",
    sourcePath: "/repo/.claude/skills/review/SKILL.md",
    trigger: "user-slash",
  });
  expect(result.prompt).toContain('User explicitly activated skill "review"');
  expect(result.prompt).toContain("Review src/a.ts");
  expect(result.metadata.skillName).toBe("review");
});

it("appends arguments when the skill has no placeholder", () => {
  expect(renderSkillBody("Follow this workflow", "fix login")).toBe(
    "Follow this workflow\n\nARGUMENTS: fix login",
  );
});
```

- [x] **步骤 2：运行红灯**

运行：`npm test -- tests/input/skill-activation.test.ts tests/input/markdown-command-loader.test.ts`

预期：FAIL，`skill-activation.ts` 尚不存在，旧 `$N` 规则也不符合 Claude Code。

- [x] **步骤 3：实现最少渲染 API**

```ts
export interface SkillActivationInput {
  name: string;
  args: string;
  body: string;
  sourcePath?: string;
  trigger: "user-slash" | "model-tool";
}

export function renderSkillBody(body: string, rawArgs: string): string;
export function renderSkillActivation(input: SkillActivationInput): {
  prompt: string;
  metadata: Record<string, unknown>;
};
```

实现 `$ARGUMENTS`、`$ARGUMENTS[N]`、`$N` 和无占位符追加，XML 属性必须转义。

- [x] **步骤 4：运行绿灯与静态检查**

运行：`npm test -- tests/input/skill-activation.test.ts tests/input/markdown-command-loader.test.ts && npx eslint src/input/skill-activation.ts src/input/markdown-command-loader.ts tests/input/skill-activation.test.ts tests/input/markdown-command-loader.test.ts && npm run typecheck`

预期：目标测试、lint、typecheck 全部通过。

- [x] **步骤 5：提交**

```bash
git add src/input/skill-activation.ts src/input/markdown-command-loader.ts tests/input/skill-activation.test.ts tests/input/markdown-command-loader.test.ts
git commit -m "feat(skill): 增加显式技能激活语义"
```

### 任务 2（Agent B）：Workspace Roots 与文件工具边界

**独占文件：**
- 创建：`src/tools/workspace-roots.ts`
- 修改：`src/tools/registry-impl.ts`
- 修改：`src/tools/default-registry.ts`
- 修改：`src/tools/glob.ts`
- 修改：`src/tools/grep.ts`
- 创建：`tests/tools/workspace-roots.test.ts`
- 创建：`tests/tools/additional-directory-tools.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
it("rejects an external path until its directory is added", async () => {
  const roots = await WorkspaceRoots.create(workDir);
  await expect(roots.assertAllowed(outsideFile)).rejects.toThrow("/add-dir");
  await roots.addDirectory(outsideDir);
  await expect(roots.assertAllowed(outsideFile)).resolves.toBe(realOutsideFile);
});

it("rejects a workspace symlink that resolves outside", async () => {
  const roots = await WorkspaceRoots.create(workDir);
  await expect(roots.assertAllowed(join(workDir, "link", "secret.txt"))).rejects.toThrow(
    "路径不在当前工作区",
  );
});
```

- [x] **步骤 2：运行红灯**

运行：`npm test -- tests/tools/workspace-roots.test.ts tests/tools/additional-directory-tools.test.ts`

预期：FAIL，`WorkspaceRoots` 尚不存在。

- [x] **步骤 3：实现共享能力并注入工具**

```ts
export class WorkspaceRoots {
  static async create(primaryRoot: string, additionalRoots?: readonly string[]): Promise<WorkspaceRoots>;
  list(): readonly string[];
  async addDirectory(path: string): Promise<AddDirectoryResult>;
  resolve(path: string): string;
  async assertAllowed(path: string): Promise<string>;
}

export function buildWorkspaceBoundaryMiddleware(roots: WorkspaceRoots): MiddlewareFunc;
```

所有路径型工具构造函数接收同一 `WorkspaceRoots`；`DefaultToolRegistryOptions` 增加 `workspaceRoots?: WorkspaceRoots`。保留 `safeResolve(workDir, path)` 兼容导出，但内部改为单 root 的严格 helper。

- [x] **步骤 4：运行绿灯与静态检查**

运行：`npm test -- tests/tools/workspace-roots.test.ts tests/tools/additional-directory-tools.test.ts tests/tools/diff-preview.test.ts tests/tools/glob.test.ts tests/tools/grep.test.ts && npx eslint src/tools tests/tools/workspace-roots.test.ts tests/tools/additional-directory-tools.test.ts && npm run typecheck`

预期：目标测试、lint、typecheck 全部通过。

- [x] **步骤 5：提交**

```bash
git add src/tools tests/tools/workspace-roots.test.ts tests/tools/additional-directory-tools.test.ts
git commit -m "feat(workspace): 支持附加工作目录"
```

### 任务 3（Agent C）：Additional Directory 配置与命令

**独占文件：**
- 创建：`src/input/add-directory.ts`
- 修改：`src/input/session-settings.ts`
- 修改：`src/input/pico-command-registry.ts`
- 创建：`tests/input/add-directory.test.ts`
- 修改：`tests/input/session-settings.test.ts`
- 修改：`tests/input/pico-command-registry.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
it("adds a directory to the current session through /add-dir", async () => {
  const manager = new FakeAdditionalDirectoryManager();
  const registry = await createPicoCommandRegistry({ ...defaults, additionalDirectoryManager: manager });
  const result = await processUserInput(`/add-dir ${outsideDir}`, { registry });
  expect(result.type).toBe("local-command");
  expect(manager.list()).toEqual([realOutsideDir]);
});

it("loads permissions.additionalDirectories from .pico/config.json", async () => {
  await expect(loadConfiguredAdditionalDirectories(workDir)).resolves.toEqual([realSharedDir]);
});
```

- [x] **步骤 2：运行红灯**

运行：`npm test -- tests/input/add-directory.test.ts tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts`

预期：FAIL，命令、配置 loader 和 session 字段尚不存在。

- [x] **步骤 3：实现命令与结构化接口**

```ts
export interface AdditionalDirectoryManager {
  list(): readonly string[];
  addDirectory(path: string): Promise<{ added: boolean; path: string; reason?: string }>;
}

export async function loadConfiguredAdditionalDirectories(workDir: string): Promise<string[]>;
```

`SessionSettings` 增加 `additionalDirectories: string[]`；`/add-dir` 无参数列出目录，有参数调用 manager，并把 canonical path 同步进 settings。

- [x] **步骤 4：运行绿灯与静态检查**

运行：`npm test -- tests/input/add-directory.test.ts tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts && npx eslint src/input tests/input/add-directory.test.ts tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts && npm run typecheck`

预期：目标测试、lint、typecheck 全部通过。

- [x] **步骤 5：提交**

```bash
git add src/input tests/input/add-directory.test.ts tests/input/session-settings.test.ts tests/input/pico-command-registry.test.ts
git commit -m "feat(workspace): 增加附加目录命令"
```

### 任务 4（主协调者）：共享接线与 TUI 可见事件

**文件：**
- 修改：`src/input/pico-command-registry.ts`
- 修改：`src/input/types.ts`
- 修改：`src/cli/main.ts`
- 修改：`src/cli/run-agent.ts`
- 修改：`src/tui/repl.tsx`
- 修改：`src/tui/tui-reporter.ts`
- 修改：`src/tui/message-row.tsx`
- 测试：`tests/tui/repl-input-routing.test.tsx`
- 测试：`tests/tui/tui-reporter.test.ts`
- 测试：`tests/cli-run-agent.test.ts`

- [x] **步骤 1：编写 Skill 命令与 transcript 失败测试**

```ts
it("executes /skill as an activated prompt command", async () => {
  const result = await processUserInput("/skill review src/a.ts", { registry });
  expect(result.type).toBe("prompt-command");
  if (result.type !== "prompt-command") return;
  expect(result.result.metadata).toMatchObject({
    skillName: "review",
    skillArgs: "src/a.ts",
    skillTrigger: "user-slash",
  });
});

it("records a durable skill activation entry before running the agent", async () => {
  await handleTuiInputSubmission("/review src/a.ts", deps);
  expect(entries).toContainEqual({
    kind: "skill",
    name: "review",
    args: "src/a.ts",
    trigger: "user-slash",
  });
});
```

- [x] **步骤 2：编写审批前路径拒绝失败测试**

```ts
it("rejects an unregistered external path before approval", async () => {
  const notifier = vi.fn();
  const result = await registry.execute({
    id: "outside",
    name: "write_file",
    arguments: JSON.stringify({ path: outsideFile, content: "x" }),
  });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("/add-dir");
  expect(notifier).not.toHaveBeenCalled();
});
```

- [x] **步骤 3：运行红灯**

运行：`npm test -- tests/input/pico-command-registry.test.ts tests/tui/repl-input-routing.test.tsx tests/cli-run-agent.test.ts`

预期：FAIL，`/skill` 仍为 local command，TUI 尚无 skill entry，workspace middleware 尚未接在 approval 之前。

- [x] **步骤 4：完成共享接线**

```ts
const workspaceRoots = await WorkspaceRoots.create(workDir, [
  ...configuredAdditionalDirectories,
  ...(options.addDirs ?? []),
]);
registry.use(buildWorkspaceBoundaryMiddleware(workspaceRoots));
registry.use(buildApprovalMiddleware(/* existing arguments */));
```

启动时合并 config/CLI dirs，创建唯一 `WorkspaceRoots`，同时注入 registry、session settings 与 command registry。`/skill` 和动态 Skill command 都调用 `renderSkillActivation()`；TUI 根据 prompt metadata 添加 Skill entry。`RunAgentCliOptions`、`ReplOptions` 增加 `addDirs?: string[]`，每轮把 session 中的 additional directories 传给 `runAgentFromCli`。

- [x] **步骤 5：运行绿灯**：`npm test -- tests/input tests/tools tests/tui/repl-input-routing.test.tsx tests/tui/tui-reporter.test.ts tests/cli-run-agent.test.ts`
- [x] **步骤 6：运行 lint/typecheck**：`npm run lint && npm run typecheck`
- [x] **步骤 7：提交**：`git commit -m "feat(tui): 接通技能与附加目录交互"`

### 任务 5（主协调者）：真实模型 E2E、文档与收口

**文件：**
- 创建：`tests/e2e/skill-workspace-real-llm-e2e.test.ts`
- 修改：`docs/tui-claude-code-parity.md`
- 修改：`ROADMAP.md`
- 修改：`PLAN.md`

- [x] **步骤 1：编写真实模型 E2E**

```ts
it.runIf(process.env.RUN_LLM_E2E === "1")(
  "follows an explicitly activated skill and respects additional directories",
  async () => {
    await writeSkill(workDir, "marker", "Create marker.txt containing SKILL_ACTIVATED.");
    await submitTui("/marker");
    await expect(readFile(join(workDir, "marker.txt"), "utf8")).resolves.toContain(
      "SKILL_ACTIVATED",
    );

    await expectWriteAttempt(outsideFile).resolves.toMatchObject({
      approvalNotices: 0,
      errorIncludes: "/add-dir",
    });
    await submitTui(`/add-dir ${outsideDir}`);
    await expectWriteAttempt(outsideFile).resolves.toMatchObject({ approvalNotices: 1 });
  },
);
```

临时 Skill 要求创建 marker；显式调用后模型必须按 Skill 操作；未授权外部目录失败且没有审批；`/add-dir` 后同一路径进入正常写审批。
- [x] **步骤 2：运行 mock 全量验证**：`npm test`
- [x] **步骤 3：运行质量验证**：`npm run lint && npm run typecheck && npm run build && npm audit --audit-level=high`
- [x] **步骤 4：运行真实模型验证**：`RUN_LLM_E2E=1 npm run test:e2e -- tests/e2e/skill-workspace-real-llm-e2e.test.ts`
- [x] **步骤 5：更新 ROADMAP/PLAN 并提交**：`git commit -m "test(e2e): 验证技能与附加目录闭环"`

## 计划自检

- 规格覆盖：Skill 激活、参数、Workspace Roots、`/add-dir`、CLI/config 来源、TUI 可见性、审批前拒绝和真实模型 e2e 均有对应任务。
- 并行安全：前三个任务使用不同 worktree；唯一共享热点 `pico-command-registry.ts` 只由 Agent C 修改，Agent A 只交付纯渲染模块，主协调者最后接线。
- 类型一致：Agent C 的 `AdditionalDirectoryManager` 是结构化接口，Agent B 的 `WorkspaceRoots` 通过鸭子类型实现；主协调者无需适配层。
- 范围控制：不实现 `/cd`、OS sandbox、目录信任数据库或全量 Claude 权限 DSL。
