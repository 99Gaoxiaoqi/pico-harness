import type { RuntimeSessionContextSnapshot } from "@pico/protocol";

export function CurrentModelHistory({ context }: { context?: RuntimeSessionContextSnapshot }) {
  const history = context?.modelHistory;
  return (
    <section className="inspector-history" aria-label="当前模型历史">
      <h3>当前模型历史</h3>
      {!history ? (
        <p className="inspector-overview__note">尚未生成上下文快照。</p>
      ) : (
        <>
          <dl className="inspector-history__metrics">
            <div>
              <dt>估算 Token</dt>
              <dd>≈{history.estimatedTokens.toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>历史消息</dt>
              <dd>{history.messageCount.toLocaleString("zh-CN")}</dd>
            </div>
            <div>
              <dt>压缩次数</dt>
              <dd>{history.compactedCount.toLocaleString("zh-CN")}</dd>
            </div>
          </dl>
          <p className="inspector-overview__note">当前历史估算，与最近请求快照独立。</p>
          <details>
            <summary>历史投影详情</summary>
            <p className="inspector-overview__note">
              压缩摘要与后续消息的有效模型视图；Token
              按字符与媒体估算，不包含完整请求的系统指令、工具定义及协议开销。
            </p>
            <p className="inspector-overview__note">
              Context v{context!.version} · 读取水位 {history.throughSequence} · 算法{" "}
              {history.estimationAlgorithm} · 投影 {history.projection}
            </p>
            <p className="inspector-overview__note">
              快照时间 {new Date(context!.generatedAt).toLocaleString("zh-CN")}
            </p>
            {history.latestCompaction ? (
              <>
                <p className="inspector-overview__note">
                  最近压缩 · 覆盖 {history.latestCompaction.coveredEventCount} 条
                </p>
                <p className="inspector-overview__note">
                  压缩记录 <code>{history.latestCompaction.checkpointId}</code>
                </p>
                <p className="inspector-overview__note">
                  覆盖边界 <code>{history.latestCompaction.throughEventId}</code>
                </p>
              </>
            ) : (
              <p className="inspector-overview__note">当前历史没有压缩 checkpoint。</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
