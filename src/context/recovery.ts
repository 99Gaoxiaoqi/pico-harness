// 错误自愈:上下文感知的 Error Recovery 提示模板注入机制。
//
// 解决痛点:大模型面对工具报错时表现笨拙 —— 机械道歉放弃任务,或盲目试错
// 连续生成一模一样的错误参数。根因是"报错信息的不可操作性":模型收到生硬的
// 底层 Error Log,遵循最小阻力路径瞎猜,而非老实重新 read_file 排障。
//
// 核心思想:报错不应只是陈述,而应是"行动指南"。引擎化身资深导师,在工具
// 执行失败时把"锦囊妙计(Recovery Hints)"塞进上下文,引导大模型走向自救。
// 锦囊中明确带"请先使用 XXX 工具"的祈使句,大模型看到系统级高优指令时
// 执行顺从度大幅上升。错误从绊脚石变成触发标准排障 SOP 的扳机。
//
// 实现极简:仅在 loop.go 插入一行字符串拦截拼接,核心控制流保持清晰。
//
// 【架构师注】本实现基于关键字字符串匹配,是极简演示。生产环境这是脆弱反模式
// (底层报错改一个字整个自愈就失效)。工业级实践应基于 POSIX 标准系统错误
// 或领域错误码(ERR_FILE_NOT_FOUND 等)做 switch-case。本讲仅演示
// Harness 在架构层如何做劫持与注入。

/**
 * RecoveryManager:工具执行失败时,根据报错特征分析并注入恢复建议。
 *
 * 拦截工具层抛出的 Error 字符串,匹配已知特征模式,返回增强后的报错信息。
 * 未匹配到特定特征时原样返回;匹配到则拼接成强有力的、带系统指导意味的行动指南。
 */
export class RecoveryManager {
  /**
   * 分析原始报错并注入锦囊妙计。
   * @param toolName 触发错误的工具名(edit_file / read_file / bash ...)
   * @param rawError 工具返回的原始错误文本
   * @returns 增强后的报错(原始错误 + [系统救援指南])
   */
  analyzeAndInject(toolName: string, rawError: string): string {
    const hint = this.matchHint(toolName, rawError);
    if (hint === "") {
      // 未匹配到特定特征:原样返回,不画蛇添足
      return rawError;
    }
    // 拼接成强有力的、带有浓厚"系统指导意味"的行动指南
    return `${rawError}\n\n[系统救援指南]: ${hint}`;
  }

  /** 按工具分类匹配已知错误特征,返回对应的恢复建议(未匹配返回空串) */
  private matchHint(toolName: string, rawError: string): string {
    const lower = rawError.toLowerCase();

    switch (toolName) {
      case "edit_file":
        // 匹配第 07 讲手写 fuzzyReplace 的固定报错格式
        if (rawError.includes("未找到") || rawError.toLowerCase().includes("old_text")) {
          return (
            "你提供的 old_text 与文件当前内容不一致,或者缺少必要的缩进。" +
            "请先使用 `read_file` 工具重新查看文件的最新内容,确保 old_text 逐字符一致(含缩进与换行),然后再重试。"
          );
        }
        if (rawError.includes("多处") || rawError.includes("多个") || rawError.includes("不唯一")) {
          return (
            "你的 old_text 不够具体,命中了多个相同的代码块。" +
            "请在 old_text 中增加更多的上下文行数,使其在工作区中唯一匹配,然后再重试。"
          );
        }
        break;

      case "read_file":
      case "write_file":
        // 匹配 Node.js fs 抛出的 POSIX 标准错误(极其稳定)
        if (lower.includes("no such file or directory") || lower.includes("enoent")) {
          return (
            "路径似乎不正确。请不要凭空猜测,先使用 `bash` 工具执行 `ls -la` 或 `find . -name '文件名'` " +
            "确认文件的真实路径,然后再重试。"
          );
        }
        if (lower.includes("permission denied") || lower.includes("eacces")) {
          return "你没有权限操作该文件。请检查工作区限制,或者思考是否需要修改其他文件。";
        }
        if (lower.includes("eisdir") || lower.includes("is a directory")) {
          return "你提供的路径是一个目录而非文件。请使用 `bash` 的 `ls` 查看目录内容,定位到具体文件后再操作。";
        }
        break;

      case "bash":
        if (lower.includes("command not found") || lower.includes("not found")) {
          return (
            "系统中未安装该命令。请先思考:是否有替代命令?或者你需要先编写脚本进行安装?" +
            "可先用 `bash` 执行 `which <命令>` 或 `command -v <命令>` 确认命令是否存在。"
          );
        }
        // 匹配我们手写的 30s 超时报错
        if (rawError.includes("超时") || lower.includes("timeout") || lower.includes("timed out")) {
          return (
            "该命令执行被超时强杀。如果它是一个常驻服务(如 server 或 watch),请将其改为后台运行(如 `命令 &`)," +
            "或者拆分为非阻塞的子任务。不要反复重试同一个会卡住的命令。"
          );
        }
        if (lower.includes("syntax error") || lower.includes("unexpected token")) {
          return "Bash 语法错误。请检查引号转义或特殊字符,确保命令在终端中可直接运行。";
        }
        if (lower.includes("permission denied")) {
          return "执行权限不足。可尝试用 `bash` 执行 `chmod +x <文件>` 添加可执行权限后再重试。";
        }
        if (lower.includes("exit code") || lower.includes("exited with")) {
          return (
            "命令执行返回了非零退出码。请仔细阅读 stderr 输出,定位具体错误行。" +
            "如果是编译/运行错误,先修复源码或命令参数,不要盲目重试同一个命令。"
          );
        }
        break;
    }

    return "";
  }
}
