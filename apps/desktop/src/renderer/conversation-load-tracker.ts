/**
 * 会话 transcript 加载竞态护栏（3-C / D12 收编）：每个会话一个单调递增的加载
 * 代数，迟到的旧加载响应不得覆盖新加载的结果（切换会话、恢复重连后并发加载
 * 的视图竞态）。
 *
 * 边界说明（D12 重评结论）：transcript 的分页/游标算法只在 daemon 服务层一处
 * （src/daemon/desktop-transcript.ts 的 selectPage / encodeCursor）；本模块
 * 不做任何分页计算，只承担"过期响应丢弃"这一视图层职责，随移动端移除后
 * D12 双实现实质消解，护栏从 runtime.ts 裸 ref 收编为单一职责模块。
 */
export interface ConversationLoadGeneration {
  readonly key: string;
  readonly generation: number;
}

export class ConversationLoadTracker {
  readonly #generations = new Map<string, number>();

  /** 为会话开启一次新的加载；返回可判定的代数句柄。 */
  begin(key: string): ConversationLoadGeneration {
    const generation = (this.#generations.get(key) ?? 0) + 1;
    this.#generations.set(key, generation);
    return { key, generation };
  }

  /** 句柄是否仍是该会话的当前加载（否 = 已被更新的加载取代，响应应丢弃）。 */
  isCurrent(load: ConversationLoadGeneration): boolean {
    return (this.#generations.get(load.key) ?? 0) === load.generation;
  }
}
