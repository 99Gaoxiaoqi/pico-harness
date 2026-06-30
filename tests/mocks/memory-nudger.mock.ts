// Mock MemoryNudger for testing PromptComposer
// 真实实现在子代理3完成后替换

export class MockMemoryNudger {
  private nudgeMap: Map<number, string> = new Map();

  async generate(_sessionId: string, turnCount: number): Promise<string | null> {
    // Mock: 返回预设的 nudge 内容
    return this.nudgeMap.get(turnCount) ?? null;
  }

  // 测试辅助方法
  setNudge(turnCount: number, content: string): void {
    this.nudgeMap.set(turnCount, content);
  }

  clear(): void {
    this.nudgeMap.clear();
  }
}
