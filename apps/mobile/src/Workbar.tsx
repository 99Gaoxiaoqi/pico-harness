import React, { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { RuntimeSessionTask } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { Button, Card, Chips, Detail, Field, Label, s, color } from "./ui";
import { FilesPanel } from "./Files";
import { TerminalPanel } from "./Terminal";
import { ReviewPanel } from "./Review";
import { SessionSettings } from "./Settings";
const tabs = [
  "任务",
  "Graph",
  "执行",
  "追踪",
  "上下文",
  "用量",
  "文件",
  "终端",
  "审查",
  "设置",
] as const;
export type WorkbarTab = (typeof tabs)[number];
export function Workbar({
  sessionId,
  initialTab = "任务",
}: {
  sessionId: string;
  initialTab?: WorkbarTab;
}) {
  const [tab, setTab] = useState<WorkbarTab>(initialTab);
  return (
    <View style={{ flex: 1 }}>
      <View style={s.body}>
        <Chips values={tabs} value={tab} onChange={setTab} />
      </View>
      {tab === "终端" ? (
        <View style={[s.body, { flex: 1 }]}>
          <TerminalPanel sessionId={sessionId} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={s.body}>
          {tab === "任务" ? (
            <Tasks sessionId={sessionId} />
          ) : tab === "文件" ? (
            <FilesPanel sessionId={sessionId} />
          ) : tab === "审查" ? (
            <ReviewPanel sessionId={sessionId} />
          ) : tab === "设置" ? (
            <SessionSettings sessionId={sessionId} />
          ) : (
            <ResourcePanel key={tab} sessionId={sessionId} tab={tab} />
          )}
        </ScrollView>
      )}
    </View>
  );
}
function Tasks({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [tasks, setTasks] = useState<readonly RuntimeSessionTask[]>([]);
  const [revision, setRevision] = useState(0);
  const [cursor, setCursor] = useState<string>();
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  async function refresh(more = false) {
    const x = await pico.request("session.tasks.query", {
      sessionId,
      limit: 30,
      ...(more && cursor ? { cursor, revision } : {}),
    });
    setTasks((old) => (more ? [...old, ...x.tasks] : x.tasks));
    setRevision(x.revision);
    setCursor(x.nextCursor);
  }
  useEffect(() => {
    void pico.perform(() => refresh());
  }, [sessionId, pico.generation]);
  return (
    <>
      <Card>
        <Field label="新任务标题" value={title} onChange={setTitle} />
        <Field label="描述" value={detail} onChange={setDetail} multiline />
        <Button
          title="添加任务"
          reason={!title.trim() ? "请输入标题" : pico.reason("session.tasks.command")}
          onPress={() =>
            void pico.perform(async () => {
              await pico.request("session.tasks.command", {
                sessionId,
                action: "create",
                title,
                detail,
                expectedRevision: revision,
                idempotencyKey: Crypto.randomUUID(),
              });
              setTitle("");
              setDetail("");
              await refresh();
            })
          }
        />
      </Card>
      <Button title="刷新" secondary onPress={() => void pico.perform(() => refresh())} />
      {tasks.map((task) => (
        <Card key={task.taskId}>
          <Text style={s.text}>
            {task.status === "completed" ? "✓" : "○"} {task.title}
          </Text>
          <Label>
            {task.detail} · {task.status}
          </Label>
          <View style={s.row}>
            {(["in_progress", "completed", "blocked"] as const).map((status, i) => (
              <Button
                key={status}
                title={["开始", "完成", "阻塞"][i]!}
                secondary
                reason={pico.reason("session.tasks.command")}
                onPress={() =>
                  void pico.perform(async () => {
                    await pico.request("session.tasks.command", {
                      sessionId,
                      action: "update",
                      taskId: task.taskId,
                      status,
                      expectedRevision: revision,
                      idempotencyKey: Crypto.randomUUID(),
                    });
                    await refresh();
                  })
                }
              />
            ))}
          </View>
        </Card>
      ))}
      {cursor && (
        <Button title="更多任务" secondary onPress={() => void pico.perform(() => refresh(true))} />
      )}
    </>
  );
}
function ResourcePanel({
  sessionId,
  tab,
}: {
  sessionId: string;
  tab: "Graph" | "执行" | "追踪" | "上下文" | "用量";
}) {
  const pico = usePico();
  const [value, setValue] = useState<unknown>();
  const [graphId, setGraphId] = useState("");
  const [graphView, setGraphView] = useState<"概览" | "时间线">("概览");
  const [cursor, setCursor] = useState<string>();
  const [through, setThrough] = useState<number>();
  const [after, setAfter] = useState<number>();
  async function refresh(more = false) {
    if (tab === "Graph") {
      const x = await pico.request("session.graph.query", {
        sessionId,
        action: graphId ? (graphView === "时间线" ? "timeline" : "get") : "list",
        ...(graphId ? { graphId } : {}),
        limit: 20,
        ...(more && cursor ? { cursor } : {}),
      });
      setValue((old: unknown) => (more ? mergeCollection(old, x) : x));
      setCursor(typeof x.nextCursor === "string" ? x.nextCursor : undefined);
    }
    if (tab === "执行") {
      const x = await pico.request("session.execution.query", {
        sessionId,
        ...(more && cursor ? { cursor } : {}),
      });
      setValue((old: unknown) => (more ? mergeCollection(old, x) : x));
      setCursor(typeof x.nextCursor === "string" ? x.nextCursor : undefined);
    }
    if (tab === "追踪") {
      const x = await pico.request("session.trace.query", {
        sessionId,
        limit: 30,
        ...(more && after !== undefined ? { afterSequence: after, throughSequence: through } : {}),
      });
      setValue((old: unknown) => (more ? mergeCollection(old, x) : x));
      setThrough(x.throughSequence);
      setAfter(x.nextAfterSequence);
    }
    if (tab === "上下文")
      setValue((await pico.request("session.context.get", { sessionId })).context);
    if (tab === "用量") setValue(await pico.request("usage.get", { sessionId }));
  }
  useEffect(() => {
    setValue(undefined);
    setCursor(undefined);
    setAfter(undefined);
    void pico.perform(() => refresh());
  }, [sessionId, pico.generation, tab, graphId, graphView]);
  const graphs =
    typeof value === "object" && value && "graphs" in value && Array.isArray(value.graphs)
      ? (value.graphs as Record<string, unknown>[])
      : [];
  return (
    <>
      <View style={s.row}>
        <Button title="刷新" secondary onPress={() => void pico.perform(() => refresh())} />
        {graphId && <Button title="返回 Graph 列表" secondary onPress={() => setGraphId("")} />}
      </View>
      {tab === "Graph" &&
        graphs.map((g) => (
          <Card key={String(g.graphId)}>
            <Text style={s.text}>{String(g.title ?? g.task ?? g.graphId)}</Text>
            <Label>{String(g.status ?? "")}</Label>
            <Button title="查看 Graph" secondary onPress={() => setGraphId(String(g.graphId))} />
            <Button
              title="停止 Graph"
              reason={pico.reason("session.graph.stop")}
              onPress={() =>
                void pico.perform(() =>
                  pico.request("session.graph.stop", { sessionId, graphId: String(g.graphId) }),
                )
              }
            />
          </Card>
        ))}
      {tab === "Graph" && graphId && (
        <>
          <Chips values={["概览", "时间线"] as const} value={graphView} onChange={setGraphView} />
          <GraphWakes value={value} sessionId={sessionId} graphId={graphId} />
        </>
      )}
      <Structured value={value} />
      {(cursor || after !== undefined) && (
        <Button title="加载更多" secondary onPress={() => void pico.perform(() => refresh(true))} />
      )}
      <Detail value={value} />
    </>
  );
}
function GraphWakes({
  value,
  sessionId,
  graphId,
}: {
  value: unknown;
  sessionId: string;
  graphId: string;
}) {
  const pico = usePico();
  const wakes =
    typeof value === "object" && value && "wakes" in value && Array.isArray(value.wakes)
      ? (value.wakes as Record<string, unknown>[])
      : [];
  return (
    <>
      {wakes.map((wake) => (
        <Card key={String(wake.wakeId)}>
          <Label>
            唤醒 {String(wake.wakeId)} · {String(wake.status ?? "")}
          </Label>
          <Button
            title="重试唤醒"
            reason={pico.reason("session.graph.retryWake")}
            onPress={() =>
              void pico.perform(() =>
                pico.request("session.graph.retryWake", {
                  sessionId,
                  graphId,
                  wakeId: String(wake.wakeId),
                }),
              )
            }
          />
        </Card>
      ))}
    </>
  );
}
/** Native labeled rows for nested diagnostic resources; JSON is optional expanded detail. */
export function Structured({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined) return <Label>正在读取…</Label>;
  if (value === null) return <Label>无</Label>;
  if (typeof value !== "object")
    return (
      <Text selectable style={s.text}>
        {String(value)}
      </Text>
    );
  if (depth > 3) return <Detail value={value} />;
  if (Array.isArray(value))
    return (
      <View style={{ gap: 10 }}>
        {value.map((x, i) => (
          <Card key={i}>
            <Structured value={x} depth={depth + 1} />
          </Card>
        ))}
      </View>
    );
  return (
    <View style={{ gap: 9 }}>
      {Object.entries(value)
        .filter(
          ([k]) =>
            !["workspacePath", "sessionId", "providerFingerprint", "contentHash"].includes(k),
        )
        .map(([key, item]) => (
          <View
            key={key}
            style={{
              borderLeftWidth: depth ? 1 : 0,
              borderLeftColor: color.line,
              paddingLeft: depth ? 10 : 0,
            }}
          >
            <Label>{labelFor(key)}</Label>
            <Structured value={item} depth={depth + 1} />
          </View>
        ))}
    </View>
  );
}
function labelFor(key: string) {
  const labels: Record<string, string> = {
    status: "状态",
    title: "标题",
    description: "描述",
    nodes: "节点",
    edges: "依赖关系",
    events: "事件",
    inputTokens: "输入 Tokens",
    outputTokens: "输出 Tokens",
    cachedInputTokens: "缓存 Tokens",
    estimatedTokens: "预计 Tokens",
    contextWindow: "上下文窗口",
    modelId: "模型",
    providerId: "Provider",
    messageCount: "消息数",
    steps: "步骤",
    reason: "原因",
    durationMs: "耗时（毫秒）",
    usage: "用量",
    tasks: "任务",
    cost: "费用",
    summary: "摘要",
    segments: "上下文构成",
  };
  return labels[key] ?? key;
}
function mergeCollection(a: unknown, b: unknown): unknown {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return b;
  return Object.fromEntries(
    Object.entries(b).map(([k, v]) => [
      k,
      Array.isArray(v) && Array.isArray((a as Record<string, unknown>)[k])
        ? [...((a as Record<string, unknown>)[k] as unknown[]), ...v]
        : v,
    ]),
  );
}
