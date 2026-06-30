// PlanStore:PLAN.md / TODO.md 的显式读写 API + Plan Mode 唤醒嗅探。
//
// 解决痛点:Plan Mode 此前只有 prompt 注入,要求模型用 bash/write_file 自建
// PLAN.md/TODO.md。但模型经常不建、或覆盖已有文件,导致断点续传失效。
//
// 借鉴 kimi-code Plan(planFilePathFor 在构造时绑定路径,data() 从磁盘读)
// 与 hermes Goal(state_meta 持久化 + /resume 恢复)的思路,把状态外部化到
// 物理文件,并由引擎在唤醒时主动嗅探、注入当前进度,而非依赖模型自律。
//
// 路径在构造时固定为 <workDir>/PLAN.md 与 <workDir>/TODO.md,不接受外部
// 传入的可变路径,从源头杜绝路径穿越风险(无需额外防护)。

import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../observability/logger.js";

const PLAN_FILENAME = "PLAN.md";
const TODO_FILENAME = "TODO.md";

/** Plan Mode 唤醒时的上下文嗅探与注入器,绑定到固定工作区路径 */
export class PlanStore {
  private readonly planPath: string;
  private readonly todoPath: string;

  constructor(workDir: string) {
    // 路径在构造时绑定,外部无法变更,从源头杜绝路径穿越
    this.planPath = join(workDir, PLAN_FILENAME);
    this.todoPath = join(workDir, TODO_FILENAME);
  }

  /** 读取 PLAN.md 内容,不存在返回 null */
  async readPlan(): Promise<string | null> {
    return readTextOrNull(this.planPath);
  }

  /** 读取 TODO.md 内容,不存在返回 null */
  async readTodo(): Promise<string | null> {
    return readTextOrNull(this.todoPath);
  }

  /** 写入 PLAN.md(覆盖) */
  async writePlan(content: string): Promise<void> {
    await writeFile(this.planPath, content, "utf8");
  }

  /** 写入 TODO.md(覆盖) */
  async writeTodo(content: string): Promise<void> {
    await writeFile(this.todoPath, content, "utf8");
  }

  /** 检查 PLAN.md 和 TODO.md 是否存在(Plan Mode 唤醒嗅探用) */
  async exists(): Promise<{ plan: boolean; todo: boolean }> {
    const [plan, todo] = await Promise.all([
      fileExists(this.planPath),
      fileExists(this.todoPath),
    ]);
    return { plan, todo };
  }

  /**
   * 生成 Plan Mode 唤醒时的上下文注入文本。
   *
   * - 文件存在(至少其一):把内容注入 prompt(断点续传),并强制要求模型
   *   从上次中断处继续,绝不覆盖。
   * - 文件均不存在:提示模型这是全新任务,需先用 write_file 创建两份文件。
   *
   * 由此实现:跨会话断电持久化 + 零成本人机协同(人类改 TODO.md 即可纠偏)。
   */
  async buildPlanContext(): Promise<string> {
    const [plan, todo] = await Promise.all([this.readPlan(), this.readTodo()]);

    // 两个文件都不存在:全新任务分支
    if (plan === null && todo === null) {
      return NEW_TASK_SPEC;
    }

    // 至少一个文件存在:断点续传分支,文案精准反映实际存在的文件
    const detected: string[] = [];
    if (plan !== null) detected.push("PLAN.md");
    if (todo !== null) detected.push("TODO.md");

    return `# 状态外部化(Plan Mode: ON)

检测到已存在 ${detected.join(" 和 ")},这是断点续传场景。以下是当前进度:

## PLAN.md 内容
\`\`\`markdown
${plan ?? "(文件不存在)"}
\`\`\`

## TODO.md 内容
\`\`\`markdown
${todo ?? "(文件不存在)"}
\`\`\`

你必须:
1. 读取上述内容,从上次中断处继续
2. 每完成一步,用 edit_file 把 TODO.md 对应条目的 [ ] 改成 [x]
3. 绝对不要覆盖 PLAN.md / TODO.md`;
  }
}

/** 全新任务分支的固定提示词:引导模型先建文件、再打勾推进 */
const NEW_TASK_SPEC = `# 状态外部化(Plan Mode: ON)

这是全新任务。你必须:
1. 先用 write_file 创建 PLAN.md,写下架构设计和技术选型
2. 再用 write_file 创建 TODO.md,拆解可执行步骤(Markdown Checkbox 格式)
3. 每完成一步,用 edit_file 把 TODO.md 对应条目改成 [x]`;

/** 读取文件文本,ENOENT 返回 null,其他错误抛出 */
async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      return null;
    }
    // 权限/IO 错误等:记 warn 后返回 null,不让 Plan Mode 嗅探阻断主流程
    logger.warn({ err, path }, "读取 Plan 文件失败");
    return null;
  }
}

/** 判断文件是否存在(用 stat 而非 readFile,避免大文件无谓读入) */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      return false;
    }
    logger.warn({ err, path }, "stat Plan 文件失败");
    return false;
  }
}

/** 判断异常是否为指定 code 的 Node ErrnoException */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
