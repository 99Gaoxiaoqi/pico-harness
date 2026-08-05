/**
 * 压缩质量评估的真实场景 case 集。
 *
 * 每 case = 一段能触发压缩的长对话历史 + 一组 gold anchor(必须保留的关键事实)。
 * 用于 e2e 真实模型测试:用真实模型生成摘要 → anchor 匹配评分 → recall 阈值。
 *
 * 设计原则:
 * - 对话够长(每条带 padding)以模拟真实 token 水位
 * - anchor 覆盖 5 个类别(file/decision/error/task/constraint)
 * - anchor 是"压缩后继续工作必须知道的事实",不是细枝末节
 */

import type { Message } from "../../src/schema/message.js";
import type { CompactionQualityCase } from "./compaction-quality.js";

/** 构造带 padding 的长文本,模拟真实对话的 token 体量 */
function padded(text: string, repeat = 8): string {
  return `${text} ${"对话上下文填充内容用于模拟真实 token 体量。".repeat(repeat)}`;
}

function userMessage(content: string): Message {
  return { role: "user", content };
}

function assistantMessage(content: string): Message {
  return { role: "assistant", content };
}

function assistantToolMessage(
  content: string,
  toolCalls: { id: string; name: string; arguments: string }[],
): Message {
  return { role: "assistant", content, toolCalls };
}

function toolResultMessage(content: string, toolCallId: string): Message {
  return { role: "user", content, toolCallId };
}

/**
 * Case 1:Debugging 会话 — 修一个 TypeScript 编译错误。
 * gold anchor:错误码、文件路径、根因、修复决策。
 */
const debuggingCase: CompactionQualityCase = {
  id: "debugging-ts-error",
  scenario: "调试 TypeScript 编译错误,定位到类型不匹配的根因",
  history: [
    userMessage(
      padded(
        "我在运行 npm run build 时遇到了 TypeScript 编译错误,帮我定位并修复。错误信息提到 src/context/compactor.ts 文件。",
      ),
    ),
    assistantMessage(
      padded(
        "我来帮你排查。先看报错信息,然后定位到具体文件。问题可能出在类型定义上。",
      ),
    ),
    assistantToolMessage("我先运行 tsc 查看完整报错。", [
      {
        id: "call_debug_1",
        name: "bash",
        arguments: JSON.stringify({ command: "npx tsc --noEmit 2>&1 | head -50" }),
      },
    ]),
    toolResultMessage(
      padded(
        "src/context/compactor.ts(217,45): error TS2345: Argument of type 'readonly Message[]' is not assignable to parameter of type 'Message[]'.\n" +
          "  The type 'readonly Message[]' is read-only and cannot be assigned to the mutable type 'Message[]'.\n" +
          "  在 createPreviewPlan 方法中,history 参数声明为 readonly Message[],但 findSafeCompactionCut 需要 Message[]。",
        6,
      ),
      "call_debug_1",
    ),
    assistantMessage(
      padded(
        "找到了。错误 TS2345 在 compactor.ts 第 217 行:findSafeCompactionCut 的参数类型不接受 readonly 数组。" +
          "根因是 readonly Message[] 传给了期望 mutable Message[] 的函数。修复方案是把 findSafeCompactionCut 的参数改成 readonly Message[]。",
      ),
    ),
    assistantToolMessage("我已确认 safe-compaction-boundary.ts 的 findSafeCompactionCut 签名,修改它的参数类型。", [
      {
        id: "call_debug_2",
        name: "edit",
        arguments: JSON.stringify({
          file: "src/context/safe-compaction-boundary.ts",
          old: "function findSafeCompactionCut(messages: Message[]",
          new: "function findSafeCompactionCut(messages: readonly Message[]",
        }),
      },
    ]),
    toolResultMessage(padded("已修改 safe-compaction-boundary.ts:86 的 findSafeCompactionCut 参数类型。", 4), "call_debug_2"),
    assistantMessage(
      padded(
        "修复完成。根因是 findSafeCompactionCut 的参数声明为 Message[] 而非 readonly Message[],导致从 createPreviewPlan 传入 readonly 数组时报 TS2345。" +
          "约束:所有压缩链路的函数签名应统一接受 readonly Message[] 以避免 mutable/readonly 不匹配。",
      ),
    ),
  ],
  gold: [
    {
      pattern: "compactor.ts",
      category: "file",
      description: "报错文件 src/context/compactor.ts",
    },
    {
      pattern: "TS2345",
      category: "error",
      description: "错误码 TS2345(类型不匹配)",
    },
    {
      pattern: /readonly\s*Message/i,
      category: "decision",
      description: "修复决策:统一使用 readonly Message[]",
    },
    {
      pattern: "findSafeCompactionCut",
      category: "decision",
      description: "关键函数名 findSafeCompactionCut",
    },
    {
      pattern: "safe-compaction-boundary.ts",
      category: "file",
      description: "实际修改的文件 safe-compaction-boundary.ts",
    },
    {
      pattern: /修复.*编译错误|修复.*build/,
      category: "task",
      description: "任务目标:修复编译错误",
    },
  ],
};

/**
 * Case 2:Refactoring 会话 — 重构一个模块,含技术决策和约束。
 * gold anchor:架构决策、约束条件、目标 API。
 */
const refactoringCase: CompactionQualityCase = {
  id: "refactoring-evidence-archive",
  scenario: "重构 evidence-archive 模块,从单例改成工厂模式",
  history: [
    userMessage(
      padded(
        "把 src/context/evidence-archive.ts 从单例模式重构为工厂模式,支持多 session 隔离。" +
          "约束:不能破坏向后兼容,现有 EvidenceArchive.create() 调用必须继续工作。",
      ),
    ),
    assistantMessage(
      padded(
        "明白。目标:把 EvidenceArchive 从全局单例改成工厂函数 createEvidenceStore(sessionId)。" +
          "决策:用工厂模式而非依赖注入,因为调用点分散且不宜引入 DI 容器。" +
          "约束:保留旧 API EvidenceArchive.create 作为 deprecated 别名,内部委托到新工厂。",
      ),
    ),
    assistantToolMessage("我先读取现有 evidence-archive.ts 的完整实现。", [
      {
        id: "call_refac_1",
        name: "read_file",
        arguments: JSON.stringify({ path: "src/context/evidence-archive.ts" }),
      },
    ]),
    toolResultMessage(
      padded(
        "export class EvidenceArchive {\n" +
          "  private static instance: EvidenceArchive | undefined;\n" +
          "  static create(): EvidenceArchive { ... }\n" +
          "  // DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES = 16 * 1024\n" +
          "  // MAX_EVIDENCE_PAGE_LIMIT_BYTES = 64 * 1024\n" +
          "}\n" +
          "当前是单例模式,static instance 持有唯一实例。",
        6,
      ),
      "call_refac_1",
    ),
    assistantMessage(
      padded(
        "现状确认:单��模式,static instance。重构方案:" +
          "1. 新增 createEvidenceStore(sessionId: string) 工厂函数,返回带 sessionId 隔离的实例。" +
          "2. EvidenceArchive.create() 保留为 deprecated 别名,委托到 createEvidenceStore('default')。" +
          "3. 分页常量 16KiB/64KiB 不变。",
      ),
    ),
    assistantToolMessage("开始重构:新增工厂函数,保留旧 API。", [
      {
        id: "call_refac_2",
        name: "edit",
        arguments: JSON.stringify({
          path: "src/context/evidence-archive.ts",
          description: "新增 createEvidenceStore 工厂 + deprecated 别名",
        }),
      },
    ]),
    toolResultMessage(
      padded("已重构 evidence-archive.ts:createEvidenceStore 工厂函数已加入,EvidenceArchive.create 标记 deprecated。", 4),
      "call_refac_2",
    ),
    assistantMessage(
      padded(
        "重构完成。关键决策记录:" +
          "采用工厂模式 createEvidenceStore 而非 DI 容器;" +
          "旧 API 保留为 deprecated 别名保证兼容;" +
          "分页上限 16KiB(page)/64KiB(max) 保持不变;" +
          "下一步:更新所有调用点从 EvidenceArchive.create() 迁移到 createEvidenceStore(sessionId)。",
      ),
    ),
  ],
  gold: [
    {
      pattern: "evidence-archive.ts",
      category: "file",
      description: "重构目标文件 src/context/evidence-archive.ts",
    },
    {
      pattern: /工厂模式|createEvidenceStore|工厂函数/,
      category: "decision",
      description: "架构决策:工厂模式 createEvidenceStore",
    },
    {
      pattern: /向后兼容|deprecated|兼容/,
      category: "constraint",
      description: "约束:保持向后兼容",
    },
    {
      pattern: /单例/,
      category: "decision",
      description: "现状描述:从单例模式重构",
    },
    {
      pattern: "16",
      category: "constraint",
      description: "分页常量 16KiB",
    },
    {
      pattern: /重构|工厂/,
      category: "task",
      description: "任务目标:重构 evidence-archive",
    },
  ],
};

/**
 * Case 3:Multi-file 任务 — 跨多个文件的功能实现,含工具调用链。
 * gold anchor:涉及的文件、关键函数名、数据流。
 */
const multiFileCase: CompactionQualityCase = {
  id: "multifile-tool-result-archive",
  scenario: "实现 tool result 归档功能,跨 4 个文件",
  history: [
    userMessage(
      padded(
        "实现一个 tool result 归档功能:超过 2048 token 的工具结果写入 Evidence CAS,模型只收到预览。" +
          "需要修改 tool-result-observation.ts、evidence-archive.ts、loop.ts、evidence-read.ts 四个文件。",
      ),
    ),
    assistantMessage(
      padded(
        "拆解任务。数据流:" +
          "tool 执行 → tool-result-observation.ts 判断 >2048 token → evidence-archive.ts 写 CAS(SHA-256)→ loop.ts 替换 body 为预览 + 披露 read_evidence → evidence-read.ts 分页回读。" +
          "决策:归档阈值用 BPE token 计数而非字符数,因为中文场景 chars/4 误差大。",
      ),
    ),
    assistantToolMessage("先实现 tool-result-observation.ts 的投影决策。", [
      {
        id: "call_multi_1",
        name: "edit",
        arguments: JSON.stringify({
          path: "src/tools/tool-result-observation.ts",
          description: "新增 buildRuntimeToolResultProjection,阈值 2048 token",
        }),
      },
    ]),
    toolResultMessage(
      padded("已实现 tool-result-observation.ts:DEFAULT_RUNTIME_PROJECTION_THRESHOLD_TOKENS = 2048,超过则归档。", 4),
      "call_multi_1",
    ),
    assistantToolMessage("接着在 evidence-archive.ts 新增 archiveRuntimeToolResult 方法。", [
      {
        id: "call_multi_2",
        name: "edit",
        arguments: JSON.stringify({
          path: "src/context/evidence-archive.ts",
          description: "新增 archiveRuntimeToolResult + SHA-256 CAS",
        }),
      },
    ]),
    toolResultMessage(
      padded("已实现 evidence-archive.ts:archiveRuntimeToolResult 写入 SHA-256 内容寻址 blob,返回 pico://evidence URI。", 4),
      "call_multi_2",
    ),
    assistantToolMessage("在 loop.ts 集成归档,工具结果超过阈值时替换 body 并披露 read_evidence。", [
      {
        id: "call_multi_3",
        name: "edit",
        arguments: JSON.stringify({
          path: "src/engine/loop.ts",
          description: "prepareRuntimeToolResult 集成归档",
        }),
      },
    ]),
    toolResultMessage(
      padded(
        "已集成 loop.ts:prepareRuntimeToolResult 在 shouldArchive 时调 archiveRuntimeToolResult,body 切换为 storage:evidence,并 disclose read_evidence。",
        5,
      ),
      "call_multi_3",
    ),
    assistantMessage(
      padded(
        "功能实现完成。总结:" +
          "归档阈值 2048 token(BPE 计数);原文写入 Evidence CAS(SHA-256 内容寻址);" +
          "模型收到 1600 字符预览 + pico://evidence URI;" +
          "read_evidence 工具支持 16KiB 分页回读;" +
          "涉及 4 个文件:tool-result-observation.ts、evidence-archive.ts、loop.ts、evidence-read.ts。" +
          "下一步:写集成测试验证归档触发和回读。",
      ),
    ),
  ],
  gold: [
    {
      pattern: "2048",
      category: "decision",
      description: "归档阈值 2048 token",
    },
    {
      pattern: /SHA-256|内容寻址|CAS/,
      category: "decision",
      description: "原文写入 SHA-256 内容寻址 CAS",
    },
    {
      pattern: "tool-result-observation.ts",
      category: "file",
      description: "文件1: tool-result-observation.ts",
    },
    {
      pattern: "evidence-archive.ts",
      category: "file",
      description: "文件2: evidence-archive.ts",
    },
    {
      pattern: "loop.ts",
      category: "file",
      description: "文件3: loop.ts",
    },
    {
      pattern: "evidence-read.ts",
      category: "file",
      description: "文件4: evidence-read.ts",
    },
    {
      pattern: /归档|archive/,
      category: "task",
      description: "任务目标:实现 tool result 归档",
    },
    {
      pattern: /read_evidence|分页/,
      category: "decision",
      description: "read_evidence 分页回读机制",
    },
  ],
};

export const compactionQualityCases: readonly CompactionQualityCase[] = [
  debuggingCase,
  refactoringCase,
  multiFileCase,
];
