export interface RecoveryManagerOptions {
  /** Host-owned shell dialect; unknown values conservatively use POSIX guidance. */
  readonly shellDialect?: () => string | undefined;
}

/** Converts known tool failures into actionable, model-visible recovery guidance. */
export class RecoveryManager {
  constructor(private readonly options: RecoveryManagerOptions = {}) {}

  analyzeAndInject(toolName: string, rawError: string): string {
    const hint = this.matchHint(toolName, rawError);
    return hint ? `${rawError}\n\n[系统救援指南]: ${hint}` : rawError;
  }

  private matchHint(toolName: string, rawError: string): string {
    const lower = rawError.toLowerCase();
    switch (toolName) {
      case "edit_file":
        if (rawError.includes("未找到") || lower.includes("old_text")) {
          return "你提供的 old_text 与文件当前内容不一致,或者缺少必要的缩进。请先使用 `read_file` 工具重新查看文件的最新内容,确保 old_text 逐字符一致(含缩进与换行),然后再重试。";
        }
        if (rawError.includes("多处") || rawError.includes("多个") || rawError.includes("不唯一")) {
          return "你的 old_text 不够具体,命中了多个相同的代码块。请在 old_text 中增加更多的上下文行数,使其在工作区中唯一匹配,然后再重试。";
        }
        break;
      case "read_file":
      case "write_file":
        if (lower.includes("no such file or directory") || lower.includes("enoent")) {
          return this.isPowerShell()
            ? "路径似乎不正确。请不要凭空猜测,先使用 `bash` 工具执行 `Get-ChildItem` 或 `Get-ChildItem -Recurse -Filter '文件名'` 确认文件的真实路径,然后再重试。"
            : "路径似乎不正确。请不要凭空猜测,先使用 `bash` 工具执行 `ls -la` 或 `find . -name '文件名'` 确认文件的真实路径,然后再重试。";
        }
        if (lower.includes("permission denied") || lower.includes("eacces")) {
          return "你没有权限操作该文件。请检查工作区限制,或者思考是否需要修改其他文件。";
        }
        if (lower.includes("eisdir") || lower.includes("is a directory")) {
          return this.isPowerShell()
            ? "你提供的路径是一个目录而非文件。请使用 `bash` 的 `Get-ChildItem` 查看目录内容,定位到具体文件后再操作。"
            : "你提供的路径是一个目录而非文件。请使用 `bash` 的 `ls` 查看目录内容,定位到具体文件后再操作。";
        }
        break;
      case "bash":
        if (lower.includes("command not found") || lower.includes("not found")) {
          return this.isPowerShell()
            ? "系统中未安装该命令。请先思考:是否有替代命令?或者你需要先编写脚本进行安装?可先用 `bash` 执行 `Get-Command <命令>` 确认命令是否存在。"
            : "系统中未安装该命令。请先思考:是否有替代命令?或者你需要先编写脚本进行安装?可先用 `bash` 执行 `which <命令>` 或 `command -v <命令>` 确认命令是否存在。";
        }
        if (rawError.includes("超时") || lower.includes("timeout") || lower.includes("timed out")) {
          return "该命令执行被超时强杀。如果它是一个常驻服务(如 server 或 watch),请改用 bash 工具的 background 参数后台运行,或者拆分为非阻塞的子任务。不要反复重试同一个会卡住的命令。";
        }
        if (lower.includes("syntax error") || lower.includes("unexpected token")) {
          return this.isPowerShell()
            ? "PowerShell 语法错误。请检查引号转义或特殊字符,确保命令在终端中可直接运行。"
            : "Bash 语法错误。请检查引号转义或特殊字符,确保命令在终端中可直接运行。";
        }
        if (lower.includes("permission denied")) {
          return this.isPowerShell()
            ? "执行权限不足。请检查文件 ACL 授权(Get-Acl)或换用其他执行方式后再重试。"
            : "执行权限不足。可尝试用 `bash` 执行 `chmod +x <文件>` 添加可执行权限后再重试。";
        }
        if (lower.includes("exit code") || lower.includes("exited with")) {
          return "命令执行返回了非零退出码。请仔细阅读 stderr 输出,定位具体错误行。如果是编译/运行错误,先修复源码或命令参数,不要盲目重试同一个命令。";
        }
        break;
    }
    return "";
  }

  private isPowerShell(): boolean {
    try {
      return this.options.shellDialect?.() === "powershell";
    } catch {
      return false;
    }
  }
}
