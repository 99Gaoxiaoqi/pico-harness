// ErrorRecovery 错误自愈提示模板注入的单元测试。
// 覆盖各工具各错误特征的匹配 + 未匹配原样返回 + 注入格式。

import { describe, expect, it } from "vitest";
import { RecoveryManager } from "../src/context/recovery.js";

describe("RecoveryManager", () => {
  const rm = new RecoveryManager();

  describe("edit_file", () => {
    it("未找到 old_text:注入 read_file 重读建议", () => {
      const out = rm.analyzeAndInject("edit_file", "Error: 在文件中未找到 old_text");
      expect(out).toContain("未找到 old_text");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("read_file");
      expect(out).toContain("缩进");
    });

    it("多处匹配:注入增加上下文建议", () => {
      const out = rm.analyzeAndInject("edit_file", "错误:匹配到了多处相同代码块");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("不够具体");
      expect(out).toContain("上下文");
    });

    it("未知错误:原样返回,不注入", () => {
      const out = rm.analyzeAndInject("edit_file", "磁盘已满");
      expect(out).toBe("磁盘已满");
      expect(out).not.toContain("[系统救援指南]");
    });
  });

  describe("read_file / write_file", () => {
    it("文件不存在(POSIX):注入 ls/find 确认路径建议", () => {
      const out = rm.analyzeAndInject("read_file", "Error: no such file or directory, open 'foo.txt'");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("ls -la");
      expect(out).toContain("凭空猜测");
    });

    it("ENOENT 错误码:同样匹配", () => {
      const out = rm.analyzeAndInject("read_file", "ENOENT: no such file or directory");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("ls");
    });

    it("无权限:注入权限检查建议", () => {
      const out = rm.analyzeAndInject("write_file", "Error: permission denied, open 'secret.key'");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("权限");
    });

    it("EISDIR 路径是目录:注入 ls 建议", () => {
      const out = rm.analyzeAndInject("read_file", "EISDIR: illegal operation on a directory, read");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("目录");
      expect(out).toContain("ls");
    });

    it("write_file 也走同一分支", () => {
      const out = rm.analyzeAndInject("write_file", "no such file or directory");
      expect(out).toContain("[系统救援指南]");
    });
  });

  describe("bash", () => {
    it("command not found:注入替代命令/确认建议", () => {
      const out = rm.analyzeAndInject("bash", "bash: foo: command not found");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("替代命令");
      expect(out).toContain("which");
    });

    it("超时:注入后台运行/拆分建议", () => {
      const out = rm.analyzeAndInject("bash", "命令执行超时(30s)");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("后台");
      expect(out).toContain("不要反复重试");
    });

    it("英文 timeout:同样匹配", () => {
      const out = rm.analyzeAndInject("bash", "Error: process timed out after 30000ms");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("后台");
    });

    it("syntax error:注入引号转义建议", () => {
      const out = rm.analyzeAndInject("bash", "bash: syntax error near unexpected token `('");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("引号转义");
    });

    it("permission denied:注入 chmod 建议", () => {
      const out = rm.analyzeAndInject("bash", "bash: ./script.sh: permission denied");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("chmod");
    });

    it("exit code 非零:注入读 stderr 建议", () => {
      const out = rm.analyzeAndInject("bash", "Command exited with code 1");
      expect(out).toContain("[系统救援指南]");
      expect(out).toContain("stderr");
    });

    it("未知 bash 错误:原样返回", () => {
      const out = rm.analyzeAndInject("bash", "网络连接中断");
      expect(out).toBe("网络连接中断");
    });
  });

  describe("未知工具", () => {
    it("未注册的工具报错:原样返回", () => {
      const out = rm.analyzeAndInject("custom_tool", "something went wrong");
      expect(out).toBe("something went wrong");
    });
  });

  describe("注入格式", () => {
    it("格式为:原始错误 + 空行 + [系统救援指南]: 建议", () => {
      const out = rm.analyzeAndInject("edit_file", "Error: 在文件中未找到 old_text");
      expect(out).toMatch(/^Error: 在文件中未找到 old_text\n\n\[系统救援指南\]: .+/);
    });

    it("原始错误完整保留在注入结果前部", () => {
      const raw = "Error: 在文件中未找到 old_text,请检查内容和缩进";
      const out = rm.analyzeAndInject("edit_file", raw);
      expect(out.startsWith(raw)).toBe(true);
    });
  });
});
