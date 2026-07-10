# 第 7 章 · 建一道安全防线

Agent 有 `bash` 工具。这意味着它可以执行任何 Shell 命令——包括 `rm -rf /`、`git push --force`、`curl ... | sh`。

我不能依赖大模型的"理智"。System Prompt 里写"千万别删库"没用——模型不总是听话的。安全不能靠提示词，要靠机制。

`rm -rf` 是真实发生过的。不是在我的 Agent 上，但在社区里听过太多案例：有人让 Agent 清理 /tmp 目录，模型误解了指令，执行了 `rm -rf / tmp`（注意那个空格），整个系统被删了。Prompt 里写了"只清理 /tmp"，但模型在生成命令时多加了一个空格。一个空格，天壤之别。

---

## Middleware：在工具执行前拦截

我没有把安全检查写在 bash 工具内部——那样的话，每次加新规则都要改工具代码，而且安全检查散落在各处，难以审计。

我的方案是在 ToolRegistry 的执行链中插入中间件。在工具真正执行之前，先过一道安全检查：

```typescript
// src/tools/registry.ts
export type RequestMiddleware = (call: ToolCall) => Promise<{
  allowed: boolean;
  reason?: string; // 拦截原因，会作为 Error 反馈给大模型
  call?: ToolCall; // 可选：修改后的调用（比如改写参数）
}>;
```

中间件在 `registry.execute()` 被调用时运行，在 `tool.execute()` 之前：

```typescript
// src/tools/registry-impl.ts
async execute(call: ToolCall): Promise<ToolResult> {
  // 1. 先过中间件链
  for (const mw of this.requestMiddlewares) {
    const result = await mw(call);
    if (!result.allowed) {
      return { toolCallId: call.id, output: result.reason!, isError: true };
    }
    if (result.call) call = result.call; // 中间件可以改写参数
  }

  // 2. 中间件全部放行，真正执行工具
  const tool = this.tools.get(call.name);
  // ...
}
```

中间件链是顺序执行的——第一个中间件拦截了，后面的就不会运行。这给安全策略提供了分层的能力：第一层检查命令是否危险，第二层检查是否需要人工审批，第三层检查是否超出预算。

而且中间件是**可插拔**的。如果你部署在安全的内网环境，可以去掉审批中间件，只保留命令检测。如果你部署在面向客户的环境，可以加上额外的敏感信息过滤中间件。Registry 上的 `use(mw)` 方法允许运行时动态挂载中间件。

---

## 高危命令检测：不是黑名单，是模式匹配

最简单的做法是维护一个危险命令黑名单：`rm -rf`、`dd if=`、`mkfs`……但这很容易被绕过——`rm -r -f`、`rm --recursive --force`、`/bin/rm -rf`、`$(which rm) -rf`。

黑名单永远追不上变体。我用了正则模式匹配：

```typescript
// src/approval/manager.ts —— 高危命令检测（部分）
const DANGEROUS_PATTERNS = [
  /rm\s+(-[a-z]*r[a-z]*f|--recursive.*--force|--force.*--recursive)/i, // 递归强制删除
  /(mkfs|dd\s+if=|mkswap|fdisk|parted)/i, // 磁盘操作
  /(git\s+push\s+--force|git\s+push\s+-f)/i, // 强制推送
  /(chmod\s+777|chmod\s+-R\s+777)/i, // 危险权限
  /curl.*\|\s*(ba)?sh/i, // curl pipe shell
  /wget.*-O\s*-\s*\|\s*(ba)?sh/i, // wget pipe shell
  /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /(shutdown|reboot|halt|poweroff)/i, // 系统关机
  // ... 共 18 条规则
];
```

这些模式覆盖了最常见的危险操作。每条规则都考虑了常见的变体——`rm -rf` 的 `-r` 和 `-f` 可以任意顺序组合、中间可以夹其他 flag。fork bomb 的正则专门匹配了那个经典的 `:(){ :|:& };:` 模式。

检测到后，不是直接拒绝——那样太粗暴，可能误杀合法的运维操作。比如运维确实需要在清理过期日志时执行 `rm -rf /var/log/app/*.gz`。而是**挂起等审批**。

---

## 人工审批：挂起而不是拒绝

审批机制的设计利用了 JavaScript 的 Promise——把执行流"挂起"，等待人类回复：

```typescript
// src/approval/manager.ts
export class ApprovalManager {
  private readonly pendingTasks = new Map<
    string,
    {
      resolve: (r: ApprovalResult) => void;
      timer: NodeJS.Timeout;
    }
  >();

  waitForApproval(taskId: string, toolName: string, args: string): Promise<ApprovalResult> {
    return new Promise((resolve) => {
      // 设置 30 分钟超时，超时自动拒绝，防止 Promise 永久挂起泄漏内存
      const timer = setTimeout(
        () => {
          this.pendingTasks.delete(taskId);
          resolve({ allowed: false, reason: "审批超时（30 分钟），自动拒绝。" });
        },
        30 * 60 * 1000,
      );

      this.pendingTasks.set(taskId, { resolve, timer });

      // 通过通知通道发送审批请求
      this.notify({
        taskId,
        toolName,
        args,
        message: formatApprovalMessage(taskId, toolName, args),
      });
    });
  }

  resolveApproval(taskId: string, allowed: boolean, reason: string): void {
    const pending = this.pendingTasks.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingTasks.delete(taskId);
    pending.resolve({ allowed, reason });
  }
}
```

整个流程：

1. Middleware 检测到高危命令 → 调用 `waitForApproval()` → 返回一个挂起的 Promise
2. 通知通道（飞书 Bot）向管理员发送审批卡片：「Agent 试图执行 `rm -rf /var/log/*`，同意还是拒绝？」
3. 管理员在飞书里点"同意"或"拒绝" → 飞书 Webhook 回调 → `resolveApproval()` 唤醒 Promise
4. 同意：放行，大模型正常执行工具。拒绝：返回 Error 给大模型，大模型收到"操作已被管理员拒绝"。

大模型甚至不知道自己被挂起了。它只觉得这个 API 请求慢了一点——因为 `waitForApproval` 在 Promise 里等着，对调用方完全透明。

30 分钟超时是防泄漏的兜底。如果管理员一直不回复，Promise 永久挂起会累积内存——每个挂起的 Promise 都持有闭包引用。超时自动拒绝，释放资源。

---

## 不只审批：多层 Guardrail

审批是最强的拦截，但不是唯一的。我还加了一个轻量级的 Guardrail 系统：

```typescript
// src/engine/reminder.ts —— Guardrail 配置
export interface GuardrailOptions {
  exactFailureWarnAt?: number; // 同参连续失败 N 次 → 警告
  exactFailureBlockAt?: number; // 同参连续失败 N 次 → 阻断
  sameToolFailureWarnAt?: number; // 同工具连续失败 N 次 → 警告
  noProgressWarnAt?: number; // N 轮无进展 → 警告
}
```

Guardrail 和 Reminder 不同。Reminder 是"提示"——在上下文中注入一条 User 消息。Guardrail 是"阻断"——直接返回 Error，不让大模型继续。两者结合形成渐进式防线：先提醒 → 再警告 → 最后阻断。

### 为什么不直接用 sudo 权限模型

有人问我：为什么不给 bash 工具一个"safe mode"，禁止某些命令但允许其他所有？为什么需要人工审批？

因为 Agent 面对的不是已知的威胁列表——它面对的是**组合爆炸**。`rm -rf /` 是危险的，但 `find / -name '*.log' -exec rm {} \;` 呢？`git push --force` 是危险的，但 `git push --force-with-lease` 呢？`curl ... | sh` 是危险的，但 `curl ... | bash` 是同一个意思。你不可能穷举所有危险的命令组合。

正则匹配是一个折中：覆盖最常见的危险模式，剩余的交由人工审批。审批不是"AI 不够聪明"的补丁——它是**人机责任边界**的体现。Agent 可以建议 `rm -rf /var/log/*.gz`，但删除生产日志的决定必须由人来下。

### 为什么不用 sudo 权限模型

另一个常见问题是：为什么不直接用 Linux 的文件权限（chroot、只读挂载）来限制 Agent 的破坏能力？

因为 Agent 可能的破坏面不只是文件系统。它可以 `git push --force` 覆盖远程分支，可以 `kubectl delete` 删掉 Kubernetes 资源，可以 `curl` 向外部服务发送数据。这些都不是文件权限能限制的。Middleware 在应用层拦截——它看得懂命令语义，不只是文件路径。

---

## 安全是设计，不是功能

我在做这套安全系统时，有一个原则贯穿始终：**安全不能是可选的。**

所有工具都走 Registry，Registry 强制过 Middleware 链。开发者不能"绕过"Middleware——Registry 的 `execute` 方法是唯一的工具执行入口。如果你想加一个不走 Middleware 的工具，你必须改 Registry 的接口——这本身就是设计上的"你确定要这么做吗？"

把安全放在执行层而不是 Prompt 层，这是 pico-harness 和很多框架的根本区别。Prompt 层的安全是"建议"，执行层的安全是"强制"。`rm -rf /` 永远不会被执行，不是因为大模型听话，而是因为 Middleware 链不允许。

### Middleware 模式为什么是对的

有人可能会问：为什么不把安全检查直接写在 bash 工具里？为什么非要引入 Middleware 这个额外的抽象层？

因为 Middleware 解决的是"关注点分离"。bash 工具应该只负责执行命令——它不需要知道什么是"危险"。安全检查应该是一个独立的关注点，可以被审计、测试、替换。

而且 Middleware 是**可组合**的。你可以同时挂载三个中间件：第一层检查高危命令，第二层检查 Token 预算是否超限，第三层记录审计日志。每个中间件只做一件事，不需要理解其他中间件的逻辑。如果你想临时关闭某个安全检查（比如在测试环境），只需要从链上移除对应的中间件，不影响其他。

这与 Express.js 的中间件设计一脉相承——每个中间件是独立的函数，链式调用，责任单一。Request 经过层层过滤，要么被某个中间件拦截，要么最终到达工具本身。

---

## 现在有了什么

安全防线已经建好：

- **Middleware 链**：可插拔的安全拦截层，在工具执行前强制检查
- **高危命令检测**：18 条正则模式，覆盖常见变体和绕过手段
- **人工审批**：Promise 挂起 + 飞书通知 + 30 分钟超时防泄漏
- **多层 Guardrail**：提醒 → 警告 → 阻断，渐进式防线

Agent 现在会思考、会执行、会纠错、不会删库。但它还是一个人在工作。有些任务——比如同时审查五个文件的代码风格、或者独立探索一个不熟悉的代码库——单线程太慢。

接下来，给它招几个帮手。

[下一章：一个人不够，招几个帮手 →](08-subagent.md)
