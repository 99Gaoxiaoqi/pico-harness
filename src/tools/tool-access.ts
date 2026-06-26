// 资源访问冲突图:工具按"访问哪个资源 + 操作类型"声明意图。
//
// 对应 kimi-code packages/agent-core/src/loop/tool-access.ts。
// 这是工业级工具调度的核心:不再是 pico 旧的"二元只读并行/含写串行"粗粒度判定,
// 而是让每个工具自报访问的资源(文件路径 × 操作类型),调度器在冲突图上做
// 最大独立集贪心并行。
//
// 核心洞察:冲突 = 任意一方含写 && 路径重叠。
//   - read + read 同文件  → 不冲突(并行)
//   - write + write 不同文件 → 不冲突(并行)  ← 旧二元模型做不到
//   - write + read 同文件  → 冲突(串行)
//   - readwrite + write 同文件 → 冲突(Edit 先读后写,与并发写同文件冲突)
//
// 跨平台:路径归一化统一转小写 + 反斜杠转正斜杠,Windows D:\foo 与 d:/foo 视为同一资源。

import { resolve } from "node:path";

/** 文件操作类型。read/search 不写,write/readwrite 含写。 */
export type FileAccessOp = "read" | "write" | "readwrite";

/** 精确文件访问(可表达为路径的资源) */
export interface FileAccess {
  readonly kind: "file";
  readonly operation: FileAccessOp;
  readonly path: string;
}

/**
 * 全量资源互斥。无法表达为文件��径的副作用(如 bash 任意 shell 命令),
 * 或副作用范围不可静态分析的工具,统一标此值 —— 与一切冲突,全局串行点。
 */
export interface AllAccess {
  readonly kind: "all";
}

/** 单个资源访问声明 */
export type ResourceAccess = FileAccess | AllAccess;

/** 一个工具调用的全部资源访问集合 */
export type ToolAccesses = readonly ResourceAccess[];

export const ToolAccesses = {
  /** 无副作用(如 echo、web 查询)。不与任何工具冲突。 */
  none(): ToolAccesses {
    return [];
  },

  /** 全量互斥。与一切冲突(bash 等无法静态分析的工具用此值)。 */
  all(): ToolAccesses {
    return [{ kind: "all" }];
  },

  /** 读单个文件 */
  readFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "read", path }];
  },

  /** 写单个文件(创建/覆盖) */
  writeFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "write", path }];
  },

  /** 读改写单个文件(Edit 必须先读后写,与并发写同文件冲突) */
  readWriteFile(path: string): ToolAccesses {
    return [{ kind: "file", operation: "readwrite", path }];
  },

  /**
   * 判定两个访问集合是否冲突(任意一对资源冲突即整体冲突)。
   * 三层短路,与 kimi-code 完全一致。
   */
  conflict(left: ToolAccesses, right: ToolAccesses): boolean {
    return left.some((l) => right.some((r) => resourceAccessesConflict(l, r)));
  },
};

/** 判定两个资源访问是否冲突 */
function resourceAccessesConflict(left: ResourceAccess, right: ResourceAccess): boolean {
  // 第一层:任一是 all → 全局互斥
  if (left.kind === "all" || right.kind === "all") return true;

  // 第二层:操作类型 —— 双方都不含写则放行(read+read / read+search)
  if (!fileOperationWrites(left.operation) && !fileOperationWrites(right.operation)) {
    return false;
  }

  // 第三层:操作含写,看路径是否重叠
  return fileAccessesOverlap(left, right);
}

/** 操作类型是否含写。read/search 不写,write/readwrite 含写。 */
function fileOperationWrites(operation: FileAccessOp): boolean {
  switch (operation) {
    case "read":
      return false;
    case "write":
    case "readwrite":
      return true;
  }
}

/** 两个文件访问的路径是否重叠(同路径) */
function fileAccessesOverlap(left: FileAccess, right: FileAccess): boolean {
  return normalizePath(left.path) === normalizePath(right.path);
}

/**
 * 路径归一化:转小写 + 反斜杠转正斜杠 + 合并重复斜杠 + 去尾斜杠。
 * 保证跨平台一致:Windows `D:\foo\bar` 与 `d:/foo/bar` 视为同一资源。
 */
function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replaceAll(/\/+/g, "/");
  const folded = normalized.toLowerCase();
  if (folded.length > 1 && folded.endsWith("/")) {
    return folded.slice(0, -1);
  }
  return folded;
}

/**
 * 把相对路径归一成绝对路径(workDir 锚定),用于 accesses 声明。
 * 与 ReadFileTool/WriteFileTool 的 safeResolve 保持一致的边界语义。
 */
export function resolveAccessPath(workDir: string, path: string): string {
  return resolve(workDir, path);
}
