import React from "react";
import { Text, View } from "react-native";
import { Card, Detail, Label, s } from "./ui";

type RecordValue = Record<string, unknown>;

/** Read-only presentation; request state, pagination and Graph actions belong to Workbar. */
export function ResourceOverview({
  value,
  tab,
}: {
  value: unknown;
  tab: "执行" | "追踪" | "Graph";
}) {
  if (value === undefined || value === null) return null;
  const data = record(value);
  if (tab === "执行") return execution(data);
  if (tab === "追踪") return trace(data);
  return graph(data);
}

function execution(data: RecordValue) {
  const runs = records(data.runs);
  const summary = record(data.summary);
  const metrics = [
    metric(summary.modelCalls, "次模型调用"),
    metric(summary.toolCalls, "次工具调用"),
    metric(summary.failedCalls, "次模型调用失败"),
    metric(summary.retries, "次重试"),
  ].filter(Boolean);
  const tokens = [
    finite(summary.inputTokens) ? `输入 ${summary.inputTokens.toLocaleString()}` : "",
    finite(summary.outputTokens) ? `输出 ${summary.outputTokens.toLocaleString()}` : "",
  ].filter(Boolean);
  return (
    <View style={{ gap: 12 }}>
      {metrics.length > 0 && (
        <Card>
          <Text style={s.text}>执行概览</Text>
          <Label>{metrics.join(" · ")}</Label>
          {tokens.length > 0 && <Label>{tokens.join(" · ")} Tokens</Label>}
          {finite(summary.costCNY) && <Label>已计价费用 ¥{summary.costCNY.toFixed(4)}</Label>}
          {finite(summary.unpricedCalls) && summary.unpricedCalls > 0 && (
            <Label>另有 {summary.unpricedCalls} 次调用暂无法计价</Label>
          )}
        </Card>
      )}
      {runs.length === 0
        ? empty("还没有执行记录", "开始一次对话后，可在这里查看运行状态和执行步骤。")
        : runs.map((run, index) => (
            <Card key={text(run.runId) || index}>
              <Text style={s.text}>运行 · {status(run.status)}</Text>
              <Label>{[date(run.at), duration(run.durationMs)].filter(Boolean).join(" · ")}</Label>
              {text(run.reason) && <Text style={s.text}>{text(run.reason)}</Text>}
              {records(run.steps).map((step, stepIndex) => (
                <View key={text(step.id) || stepIndex} style={{ gap: 4 }}>
                  <Text style={s.text}>
                    {text(step.title) || stepKind(step.kind)} · {status(step.status)}
                  </Text>
                  <Label>
                    {[stepKind(step.kind), text(step.modelId), duration(step.durationMs)]
                      .filter(Boolean)
                      .join(" · ")}
                  </Label>
                  {text(step.purpose) && <Label>{text(step.purpose)}</Label>}
                  {text(step.error) && <Text style={s.text}>{text(step.error)}</Text>}
                </View>
              ))}
              <Detail title="运行详情" value={run} />
            </Card>
          ))}
    </View>
  );
}

function trace(data: RecordValue) {
  const events = records(data.events);
  return (
    <View style={{ gap: 12 }}>
      {events.length === 0
        ? empty("还没有过程事件", "模型调用、工具执行和审批等过程会记录在这里。")
        : events.map((entry, index) => {
            const event = record(entry.event);
            const detail = record(event.data);
            const description = [text(detail.toolName), text(detail.model), text(detail.purpose)]
              .filter(Boolean)
              .join(" · ");
            return (
              <Card key={text(entry.eventId) || index}>
                <Text style={s.text}>{eventLabel(entry.kind)}</Text>
                <Label>
                  {[date(entry.at), finite(entry.sequence) ? `第 ${entry.sequence} 条` : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </Label>
                {description && <Text style={s.text}>{description}</Text>}
                {(text(detail.status) || text(detail.decision)) && (
                  <Label>{status(detail.status ?? detail.decision)}</Label>
                )}
                {text(detail.reason) && <Label>{text(detail.reason)}</Label>}
                {text(detail.error) && <Text style={s.text}>{text(detail.error)}</Text>}
                {entry.partial === true && <Label>这条事件尚不完整</Label>}
                <Detail title="事件详情" value={entry} />
              </Card>
            );
          })}
    </View>
  );
}

function graph(data: RecordValue) {
  if (Array.isArray(data.graphs)) {
    const graphs = records(data.graphs);
    if (graphs.length === 0)
      return empty("还没有协作任务", "任务启用多智能体协作后，可在这里查看分工和进度。");
    return (
      <Card>
        <Text style={s.text}>协作概览</Text>
        <Label>
          {graphs.length} 个协作周期 · {graphs.filter((item) => item.phase === "open").length}{" "}
          个进行中 · {graphs.filter((item) => item.phase === "finished").length} 个已结束
        </Label>
      </Card>
    );
  }
  const summary = record(data.summary ?? data.graph);
  const counts = record(summary.counts);
  const timeline = records(data.items);
  const runtimeClaims = records(data.runtimeClaims);
  const diagnostics = records(data.diagnostics).filter((item) => item.state !== "resolved");
  return (
    <View style={{ gap: 12 }}>
      {Object.keys(summary).length > 0 && (
        <Card>
          <Text style={s.text}>
            {finite(summary.epoch) ? `第 ${summary.epoch} 轮协作` : "协作任务"} ·{" "}
            {status(summary.phase)}
          </Text>
          <Label>
            {[
              metric(counts.operators, "位协作者"),
              metric(counts.intents, "项分工"),
              metric(counts.records, "份成果"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          {date(summary.createdAt) && <Label>开始于 {date(summary.createdAt)}</Label>}
          {date(summary.finishedAt) && <Label>结束于 {date(summary.finishedAt)}</Label>}
          {runtimeClaims.length > 0 && (
            <Label>
              {Object.entries(
                runtimeClaims.reduce<Record<string, number>>((totals, claim) => {
                  const label = status(claim.status);
                  totals[label] = (totals[label] ?? 0) + 1;
                  return totals;
                }, {}),
              )
                .map(([label, count]) => `${count} 项${label}`)
                .join(" · ")}
            </Label>
          )}
        </Card>
      )}
      {records(data.operators).map((operator, index) => {
        const instructions = records(data.intents).filter(
          (intent) => intent.operatorId === operator.operatorId,
        );
        return (
          <Card key={text(operator.operatorId) || index}>
            <Text style={s.text}>
              {text(operator.description) || text(operator.role) || "协作者"}
            </Text>
            {instructions.map((intent, intentIndex) => (
              <Label key={text(intent.intentId) || intentIndex}>{text(intent.instruction)}</Label>
            ))}
          </Card>
        );
      })}
      {diagnostics.map((item, index) => (
        <Card key={text(item.diagnosticId) || index}>
          <Text style={s.text}>协作需要关注</Text>
          <Label>{text(item.message) || "查看协作详情了解原因。"}</Label>
        </Card>
      ))}
      {Array.isArray(data.items) &&
        timeline.length === 0 &&
        empty("还没有协作事件", "协作任务的调度和成果会显示在时间线中。")}
      {timeline.map((item, index) => (
        <Card key={text(item.id) || index}>
          <Text style={s.text}>{eventLabel(item.kind)}</Text>
          <Label>
            {[date(item.at), text(item.status) ? status(item.status) : ""]
              .filter(Boolean)
              .join(" · ")}
          </Label>
          {text(item.detail) && <Label>{text(item.detail)}</Label>}
          <Detail title="协作事件详情" value={item} />
        </Card>
      ))}
    </View>
  );
}

function empty(title: string, description: string) {
  return (
    <Card>
      <Text style={s.text}>{title}</Text>
      <Label>{description}</Label>
    </Card>
  );
}
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
function records(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function metric(value: unknown, suffix: string) {
  return finite(value) ? `${value.toLocaleString()} ${suffix}` : "";
}
function duration(value: unknown) {
  return finite(value)
    ? value < 1000
      ? `${Math.round(value)} 毫秒`
      : `${(value / 1000).toFixed(1)} 秒`
    : "";
}
function date(value: unknown) {
  if (typeof value !== "string" && !finite(value)) return "";
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
function status(value: unknown) {
  const labels: Record<string, string> = {
    open: "进行中",
    finished: "已结束",
    running: "执行中",
    completed: "已完成",
    succeeded: "已完成",
    success: "成功",
    failed: "失败",
    failure: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    pending: "等待中",
    not_started: "尚未开始",
    waiting_permission: "等待批准",
    approved: "已批准",
    rejected: "已拒绝",
    claimed: "已认领",
    executing: "执行中",
    requested: "已申请",
    provisioned: "已就绪",
    stopped: "已停止",
    stopping: "正在停止",
    delivered: "已送达",
    needs_attention: "需要处理",
    retryable_failed: "失败，可重试",
    add: "新增分工",
    stop: "停止分工",
    finish: "结束协作",
    batch: "批量更新",
    registered: "已登记",
    consumed: "已处理",
    resolved: "已解决",
    active: "使用中",
    retained: "已保留",
    cleaned: "已清理",
    fulfilled: "已满足",
  };
  return labels[text(value)] ?? "状态未记录";
}
function stepKind(value: unknown) {
  const labels: Record<string, string> = {
    model: "模型调用",
    tool: "工具执行",
    permission: "权限审批",
    compaction: "上下文压缩",
    error: "错误",
    memory: "记忆检索",
    goal_evaluation: "目标检查",
  };
  return labels[text(value)] ?? "执行步骤";
}
function eventLabel(value: unknown) {
  const labels: Record<string, string> = {
    "run.started": "运行开始",
    "run.terminal": "运行结束",
    "message.committed": "消息已记录",
    "model.call.started": "开始调用模型",
    "model.call.settled": "模型调用结束",
    "tool.started": "开始执行工具",
    "tool.result.recorded": "工具结果已记录",
    "tool.group.loaded": "工具已加载",
    "tool.recovery.resolved": "工具执行已恢复",
    "tool.result.projection.recorded": "工具结果已更新",
    "approval.requested": "等待批准",
    "approval.settled": "审批已处理",
    "context.checkpoint.recorded": "上下文已整理",
    "session.forked": "会话已分支",
    "memory.recall.recorded": "已检索记忆",
    "agent.output": "协作成果已提交",
    "plan.proposed": "计划已提出",
    "plan.revised": "计划已修改",
    "plan.approved": "计划已批准",
    "plan.rejected": "计划已拒绝",
    "plan.step.updated": "计划步骤已更新",
    "plan.execution.started": "开始执行计划",
    "plan.execution.completed": "计划已完成",
    "plan.execution.interrupted": "计划已中断",
    "plan.execution.resumed": "计划已恢复",
    "plan.execution.cancelled": "计划已取消",
    "graph.created": "协作周期开始",
    "graph.finished": "协作周期结束",
    "schedule.committed": "协作分工已更新",
    "operator.provisioned": "协作者已就绪",
    "operator.stopped": "协作者已停止",
    "activation.claimed": "协作任务已认领",
    "activation.executing": "协作任务开始执行",
    "activation.cancelled": "协作任务已取消",
    "record.committed": "协作成果已提交",
    "resource.retained": "资源已保留",
    "workspace.requested": "工作区已申请",
    "workspace.active": "工作区已就绪",
    "workspace.retained": "工作区已保留",
    "workspace.cleaned": "工作区已清理",
    "yield.registered": "开始等待协作结果",
    "yield.resolved": "等待结束",
    "diagnostic.recorded": "协作需要关注",
    "diagnostic.resolved": "协作问题已恢复",
    "wake.enqueued": "已安排继续执行",
    "wake.settled": "唤醒已处理",
    "wake.attempted": "尝试继续执行",
  };
  return labels[text(value)] ?? "其他过程事件";
}
