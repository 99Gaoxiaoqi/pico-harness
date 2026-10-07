import React, { useEffect, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import type { RuntimeGoalSnapshot } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Detail, Field, Label, s } from "../ui";

export function SessionActions({
  sessionId,
  idle,
  onSession,
  onClose,
}: {
  sessionId: string;
  idle: boolean;
  onSession: (id: string, parentSessionId?: string) => void;
  onClose: () => void;
}) {
  const pico = usePico();
  const [snapshot, setSnapshot] = useState<RuntimeGoalSnapshot | null>();
  const [condition, setCondition] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const fence = useRef(0);
  const readVersion = useRef(0);
  const idleRef = useRef(idle);
  idleRef.current = idle;
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}:${sessionId}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  async function load(token = fence.current) {
    if (pico.connected === false) return;
    const read = ++readVersion.current;
    const x = await pico.request("goal.get", { sessionId });
    if (
      token === fence.current &&
      read === readVersion.current &&
      readScope === currentScope.current
    )
      setSnapshot(x.goal);
  }
  useEffect(() => {
    ++fence.current;
    setSnapshot(undefined);
    setCondition("");
    setBudget("");
    setNotice("");
    return () => {
      ++fence.current;
      ++readVersion.current;
    };
  }, [sessionId, pico.generation]);
  useEffect(() => {
    const token = fence.current;
    if (pico.connected === false) return;
    if (!pico.reason("goal.get")) void pico.perform(() => load(token));
    const off = pico.onNotification((event) => {
      if (
        event.scope.sessionId === sessionId &&
        event.topic === "session.resourceChanged" &&
        event.payload &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        "resource" in event.payload &&
        event.payload.resource === "goal" &&
        !lock.current &&
        !pico.reason("goal.get")
      )
        void pico.perform(() => load(token));
    });
    return () => {
      ++readVersion.current;
      off();
    };
  }, [sessionId, pico.generation, pico.connected, pico.syncRevision]);
  async function perform(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    ++readVersion.current;
    setBusy(true);
    const token = fence.current;
    try {
      await task();
    } finally {
      lock.current = false;
      if (token === fence.current) setBusy(false);
    }
  }
  const goal = snapshot?.currentGoal;
  const stateLabels: Record<string, string> = {
    active: "执行中",
    waiting: "等待下一条消息",
    paused: "已暂停",
    achieved: "已达成",
    impossible: "无法达成",
    stalled: "需要处理",
    budget_limited: "达到预算",
    max_iterations: "达到轮次上限",
    cleared: "已清除",
  };
  async function control(action: "arm" | "pause" | "resume" | "clear") {
    await perform(async () => {
      const token = fence.current;
      const read = ++readVersion.current;
      const latest = (await pico.request("goal.get", { sessionId })).goal;
      if (
        token !== fence.current ||
        read !== readVersion.current ||
        readScope !== currentScope.current
      )
        return;
      setSnapshot(latest);
      const current = latest?.currentGoal;
      // Never silently adopt a newer revision for an action the user already reviewed.
      if ((current?.revision ?? 0) !== (goal?.revision ?? 0) || current?.id !== goal?.id) {
        setNotice("目标状态已变化，请查看最新状态后再操作。");
        return;
      }
      const x = await pico.request("goal.control", {
        sessionId,
        action,
        expectedRevision: current?.revision ?? 0,
        ...(action === "arm"
          ? {
              condition: condition.trim(),
              ...(budget.trim() ? { tokenBudget: Number(budget) } : {}),
            }
          : { goalId: current?.id }),
      });
      if (token !== fence.current) return;
      ++readVersion.current;
      setSnapshot(x.goal);
      setNotice(
        action === "arm" || action === "resume"
          ? "目标已设置，发送下一条消息后启动。"
          : action === "clear"
            ? "目标已清除。"
            : "目标已暂停。",
      );
    });
  }
  const idleReason = busy ? "正在处理" : !idle ? "等待当前任务结束后操作" : undefined;
  function confirmSessionAction(kind: "fork" | "compact") {
    if (idleReason) return;
    const token = fence.current;
    const scope = currentScope.current;
    Alert.alert(
      kind === "fork" ? "复制为新会话？" : "压缩上下文？",
      kind === "fork"
        ? "继承当前对话的上下文和设置，在新会话中尝试另一种方案。两个会话共用同一项目目录，文件修改会相互影响。"
        : "通过模型把较早的对话整理为摘要，减少后续请求的上下文占用。历史记录仍可查看，摘要可能省略细节。",
      [
        { text: "取消", style: "cancel" },
        {
          text: kind === "fork" ? "创建新会话" : "确认压缩",
          onPress: () => {
            if (token !== fence.current || scope !== currentScope.current || !idleRef.current)
              return;
            void pico.perform(() =>
              perform(async () => {
                if (kind === "fork") {
                  const x = await pico.request("session.fork", { sessionId });
                  if (token === fence.current && scope === currentScope.current) {
                    onClose();
                    onSession(x.session.sessionId);
                  }
                } else {
                  const x = await pico.request("session.compact", { sessionId });
                  if (token === fence.current && scope === currentScope.current)
                    setNotice(
                      `已压缩：${x.beforeMessageCount} → ${x.afterMessageCount} 条上下文消息。`,
                    );
                }
              }),
            );
          },
        },
      ],
    );
  }
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Button
          title="复制为新会话"
          secondary
          reason={idleReason ?? pico.reason("session.fork")}
          onPress={() => confirmSessionAction("fork")}
        />
        <Label>沿用当前上下文尝试另一种方案，新旧会话共用项目文件。</Label>
      </View>
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={s.text}>
          上下文管理
        </Text>
        <Button
          title="压缩上下文"
          secondary
          reason={idleReason ?? pico.reason("session.compact")}
          onPress={() => confirmSessionAction("compact")}
        />
        <Label>用摘要减少后续请求的上下文占用，保留历史记录；适用于较长对话。</Label>
      </View>
      <Text accessibilityRole="header" style={s.text}>
        持续目标
      </Text>
      {pico.reason("goal.get") ? (
        <Label>{pico.reason("goal.get")}</Label>
      ) : snapshot === undefined ? (
        <Label>正在读取目标…</Label>
      ) : goal ? (
        <>
          <Text style={s.text}>{goal.condition}</Text>
          <Label>
            {stateLabels[goal.status] ?? goal.status} · {goal.iterations}/{goal.maxIterations} 轮
          </Label>
          {goal.lastReason && <Label>{goal.lastReason}</Label>}
          <View style={s.row}>
            {(goal.status === "active" || goal.status === "waiting") && (
              <Button
                title="暂停目标"
                secondary
                reason={busy ? "正在处理" : pico.reason("goal.control")}
                onPress={() => void pico.perform(() => control("pause"))}
              />
            )}
            {goal.status === "paused" && (
              <Button
                title="恢复目标"
                secondary
                reason={busy ? "正在处理" : pico.reason("goal.control")}
                onPress={() => void pico.perform(() => control("resume"))}
              />
            )}
            <Button
              title="清除目标"
              quiet
              reason={busy ? "正在处理" : pico.reason("goal.control")}
              onPress={() =>
                Alert.alert("清除当前目标？", goal.condition, [
                  { text: "返回" },
                  { text: "清除", onPress: () => void pico.perform(() => control("clear")) },
                ])
              }
            />
          </View>
        </>
      ) : (
        <Label>当前会话没有持续目标。</Label>
      )}
      {snapshot !== undefined &&
        (!goal ||
          [
            "cleared",
            "achieved",
            "impossible",
            "stalled",
            "budget_limited",
            "max_iterations",
          ].includes(goal.status)) && (
          <>
            <Field label="目标达成条件" value={condition} onChange={setCondition} multiline />
            <Field label="Token 预算（可选）" value={budget} onChange={setBudget} />
            <Button
              title="设置目标"
              reason={
                busy
                  ? "正在处理"
                  : !condition.trim()
                    ? "请输入达成条件"
                    : budget.trim() &&
                        (!Number.isSafeInteger(Number(budget)) || Number(budget) <= 0)
                      ? "预算必须为正整数"
                      : pico.reason("goal.control")
              }
              onPress={() => void pico.perform(() => control("arm"))}
            />
            <Label>设置后等待下一条消息启动。</Label>
          </>
        )}
      {!!notice && (
        <Text accessibilityRole="alert" style={s.text}>
          {notice}
        </Text>
      )}
      {snapshot && <Detail title="目标高级详情" value={snapshot} />}
    </View>
  );
}
